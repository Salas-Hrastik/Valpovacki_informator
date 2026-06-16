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
  const vec: RetrievedChunk[] = (vecRows ?? []) as RetrievedChunk[];

  // 2) Leksički (FTS) kanal — UVIJEK doprinosi (hibridni dohvat). Ključno za
  // činjenična pitanja i popise (imena vijećnika, brojevi, kontakti) koje vektorsko
  // pretraživanje slabo rangira jer se popis imena semantički ne poklapa s upitom.
  let fts: RetrievedChunk[] = [];
  if (config.ragFtsFallback) {
    const { data: ftsRows, error: ftsErr } = await sb.rpc('search_chunks_fts', {
      query_text: query,
      match_count: topK,
    });
    if (!ftsErr && ftsRows) {
      const vecIds = new Set(vec.map((r) => r.chunk_id));
      fts = (ftsRows as RetrievedChunk[])
        .filter((r) => !vecIds.has(r.chunk_id))
        .map((r) => ({ ...r, score: Math.min(r.score, threshold) }));
    }
  }

  // 3) Hibridno ISPREPLITANJE (~2 vektor : 1 FTS). Bez ovoga bi, kad vektor vrati
  // pun set, leksički pogoci (npr. službena stranica "Aktualni sastav" s imenima)
  // uvijek završili ispod praga i bili odrezani. Ovako im se jamči mjesto u kontekstu.
  const hosts = options.allowedHosts ?? config.allowedHosts;
  const isAllowedHostUrl = (u: string): boolean => {
    try {
      return hosts.includes(new URL(u).hostname);
    } catch {
      return false;
    }
  };
  const ordered: RetrievedChunk[] = [];
  let vi = 0;
  let fi = 0;
  let k = 0;
  while (vi < vec.length || fi < fts.length) {
    const takeFts = (k % 3 === 2 && fi < fts.length) || vi >= vec.length;
    const r = takeFts ? fts[fi++] : vec[vi++];
    if (r && isAllowedHostUrl(r.url)) ordered.push(r);
    k++;
  }

  // 4) Deduplikacija po URL-u (najviše 3 isječka) + proračun konteksta, u redoslijedu
  // prioriteta (NE sortiramo po rezultatu — ispreplitanje već nosi prioritet).
  const perUrl = new Map<string, number>();
  const final: RetrievedChunk[] = [];
  let budget = config.ragContextCharBudget;
  for (const r of ordered) {
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
