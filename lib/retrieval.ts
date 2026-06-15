/**
 * Retrieval — dohvaćanje relevantnih isječaka iz Supabase (pgvector + FTS).
 *
 * Tijek:
 *   1. vektorsko pretraživanje (RPC match_chunks; kosinusna sličnost, top-K,
 *      prag RAG_SCORE_THRESHOLD),
 *   2. opcionalni leksički rezervni kanal (RPC search_chunks_fts) kada
 *      vektorsko pretraživanje vrati premalo rezultata,
 *   3. spajanje, deduplikacija i ograničavanje konteksta na proračun znakova.
 */
import { config } from './config';
import { embedText } from './embeddings';
import { supabaseAdmin } from './supabase';

export interface RetrievedChunk {
  chunk_id: string;
  text: string;
  title: string;
  url: string;
  fetched_at: string; // ISO datum zadnje provjere izvora
  score: number;
}

export interface RetrieveOptions {
  topK?: number;
  scoreThreshold?: number;
  /** Dodatni filtar po dopuštenim domenama (sigurnosna mreža za citate). */
  allowedHosts?: string[];
}

export async function retrieve(
  query: string,
  options: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  const topK = options.topK ?? config.ragTopK;
  const threshold = options.scoreThreshold ?? config.ragScoreThreshold;
  const sb = supabaseAdmin();

  // 1) Vektorsko pretraživanje
  const queryEmbedding = await embedText(query);
  const { data: vecRows, error: vecErr } = await sb.rpc('match_chunks', {
    query_embedding: JSON.stringify(queryEmbedding), // pgvector prima '[...]' literal
    match_count: topK,
    score_threshold: threshold,
  });
  if (vecErr) throw new Error(`match_chunks: ${vecErr.message}`);
  let results: RetrievedChunk[] = (vecRows ?? []) as RetrievedChunk[];

  // 2) Leksički (FTS) kanal — UVIJEK doprinosi (hibridni dohvat). Ključno za
  // činjenična pitanja i popise (imena vijećnika, brojevi, kontakti) koje vektorsko
  // pretraživanje slabo rangira jer se popis imena semantički ne poklapa s upitom.
  // FTS pogoci dobivaju konzervativan rezultat pa vektorski i dalje imaju prednost.
  if (config.ragFtsFallback) {
    const { data: ftsRows, error: ftsErr } = await sb.rpc('search_chunks_fts', {
      query_text: query,
      match_count: topK,
    });
    if (!ftsErr && ftsRows) {
      const seen = new Set(results.map((r) => r.chunk_id));
      for (const row of ftsRows as RetrievedChunk[]) {
        if (!seen.has(row.chunk_id)) {
          // FTS rang nije usporediv s kosinusnom sličnošću — dodjeljujemo
          // konzervativan rezultat kako bi vektorski pogoci imali prednost.
          results.push({ ...row, score: Math.min(row.score, threshold) });
          seen.add(row.chunk_id);
        }
      }
    }
  }

  // 3) Sigurnosni filtar domena u citatima
  const hosts = options.allowedHosts ?? config.allowedHosts;
  results = results.filter((r) => {
    try {
      return hosts.includes(new URL(r.url).hostname);
    } catch {
      return false;
    }
  });

  // 4) Deduplikacija po URL-u (najviše 2 isječka po dokumentu) + proračun konteksta
  results.sort((a, b) => b.score - a.score);
  const perUrl = new Map<string, number>();
  const final: RetrievedChunk[] = [];
  let budget = config.ragContextCharBudget;
  for (const r of results) {
    const n = perUrl.get(r.url) ?? 0;
    if (n >= 3) continue; // do 3 isječka po dokumentu (popisi imena znaju biti duži)
    if (r.text.length > budget) continue;
    perUrl.set(r.url, n + 1);
    budget -= r.text.length;
    final.push(r);
    if (final.length >= topK) break;
  }
  return final;
}

/** Jedinstveni popis izvora (za prikaz citata ispod odgovora). */
export function uniqueSources(chunks: RetrievedChunk[]) {
  const byUrl = new Map<string, { title: string; url: string; score: number; fetched_at: string }>();
  for (const c of chunks) {
    const existing = byUrl.get(c.url);
    if (!existing || c.score > existing.score) {
      byUrl.set(c.url, {
        title: c.title || c.url,
        url: c.url,
        score: Number(c.score.toFixed(3)),
        fetched_at: c.fetched_at,
      });
    }
  }
  return [...byUrl.values()];
}
