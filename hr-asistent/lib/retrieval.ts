/**
 * Retrieval — dohvaćanje relevantnih isječaka knjige iz Supabase (pgvector + FTS).
 *
 * Tijek:
 *   1. vektorsko pretraživanje (RPC match_chunks; kosinusna sličnost, top-K,
 *      prag RAG_SCORE_THRESHOLD),
 *   2. opcionalni leksički rezervni kanal (RPC search_chunks_fts) kada
 *      vektorsko pretraživanje vrati premalo rezultata,
 *   3. reranking (LLM), deduplikacija i ograničavanje konteksta na proračun znakova.
 */
import { config } from './config';
import { embedText } from './embeddings';
import { rerankChunks } from './rerank';
import { supabaseAdmin } from './supabase';

export interface RetrievedChunk {
  chunk_id: string;
  text: string;
  title: string; // naslov poglavlja/odjeljka (uključuje raspon stranica)
  url: string;   // stabilna interna referenca odjeljka (knjiga://…)
  fetched_at: string; // ISO datum zadnje ingestije odjeljka
  score: number;
}

export interface RetrieveOptions {
  topK?: number;
  scoreThreshold?: number;
}

export async function retrieve(
  query: string,
  options: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  const topK = options.topK ?? config.ragTopK;
  const threshold = options.scoreThreshold ?? config.ragScoreThreshold;
  const sb = supabaseAdmin();
  // Za reranking dohvaćamo ŠIRI skup kandidata pa ih LLM presloži po relevantnosti.
  const poolSize = config.ragRerank ? Math.max(config.ragRerankCandidates, topK) : topK;

  // 1) Vektorsko pretraživanje (širi skup) — HNSW indeks, brzo.
  const queryEmbedding = await embedText(query);
  const { data: vecRows, error: vecErr } = await sb.rpc('match_chunks', {
    query_embedding: JSON.stringify(queryEmbedding), // pgvector prima '[...]' literal
    match_count: poolSize,
    score_threshold: threshold,
  });
  if (vecErr) throw new Error(`match_chunks: ${vecErr.message}`);
  const vec: RetrievedChunk[] = (vecRows ?? []) as RetrievedChunk[];

  // 2) Leksički (FTS) kanal — SAMO KAO REZERVA kad vektor vrati premalo rezultata.
  // Ključan za točne stručne pojmove i imena (npr. "assessment centar", autori)
  // kod kojih semantička sličnost zna promašiti.
  let fts: RetrievedChunk[] = [];
  const useFts = config.ragFtsFallback && vec.length < config.ragFtsMinVec;
  if (useFts) {
    const { data: ftsRows, error: ftsErr } = await sb.rpc('search_chunks_fts', {
      query_text: lexicalQuery(query),
      match_count: poolSize,
    });
    if (!ftsErr && ftsRows) {
      const vecIds = new Set(vec.map((r) => r.chunk_id));
      fts = (ftsRows as RetrievedChunk[])
        .filter((r) => !vecIds.has(r.chunk_id))
        .map((r) => ({ ...r, score: Math.min(r.score, threshold) }));
    }
  }

  // 3) Skup kandidata: ispleti vektor+FTS (FTS zajamčeno zastupljen), ograniči na poolSize.
  const candidates: RetrievedChunk[] = [];
  let vi = 0;
  let fi = 0;
  let k = 0;
  while ((vi < vec.length || fi < fts.length) && candidates.length < poolSize) {
    const takeFts = (k % 3 === 2 && fi < fts.length) || vi >= vec.length;
    const r = takeFts ? fts[fi++] : vec[vi++];
    if (r) candidates.push(r);
    k++;
  }

  // 4) Reranking — LLM presloži kandidate po stvarnoj relevantnosti (bira pravi
  // odjeljak knjige među mnogo sličnih). Otporno na greške: vraća izvorni poredak ako zakaže.
  const ordered = await rerankChunks(query, candidates, Math.min(candidates.length, topK + 4));

  // 5) Deduplikacija po odjeljku (najviše 3 isječka) + proračun konteksta, u redoslijedu
  // prioriteta (NE sortiramo po rezultatu — rerank/ispreplitanje već nose prioritet).
  const perSection = new Map<string, number>();
  const final: RetrievedChunk[] = [];
  let budget = config.ragContextCharBudget;
  for (const r of ordered) {
    const n = perSection.get(r.url) ?? 0;
    if (n >= 3) continue; // do 3 isječka po odjeljku (definicije + nabrajanja znaju biti duži)
    if (r.text.length > budget) continue;
    perSection.set(r.url, n + 1);
    budget -= r.text.length;
    final.push(r);
    if (final.length >= topK) break;
  }
  return final;
}

/**
 * Iz upita zadržava samo značajne riječi (≥4 slova/znamenke) za leksičku pretragu.
 * Izbacuje česte kratke riječi (što, su, za, na, i…) koje bi prefiks-upit učinile
 * sporim i nepreciznim. Ako ne ostane ništa, vraća izvorni upit.
 */
function lexicalQuery(query: string): string {
  const words = query
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length >= 4);
  return words.length > 0 ? words.join(' ') : query;
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
