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
import { rerankChunks } from './rerank';
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
  // FTS rangiranje je skupo (više sekundi na maloj instanci), a vektor obično
  // vrati dovoljno; tako se za većinu pitanja FTS preskače i dohvat je puno brži.
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

  // 3) Skup kandidata: ispleti vektor+FTS (FTS zajamčeno zastupljen), filtriraj
  // domene, ograniči na poolSize.
  const hosts = options.allowedHosts ?? config.allowedHosts;
  const isAllowedHostUrl = (u: string): boolean => {
    try {
      return hosts.includes(new URL(u).hostname);
    } catch {
      return false;
    }
  };
  const candidates: RetrievedChunk[] = [];
  let vi = 0;
  let fi = 0;
  let k = 0;
  while ((vi < vec.length || fi < fts.length) && candidates.length < poolSize) {
    const takeFts = (k % 3 === 2 && fi < fts.length) || vi >= vec.length;
    const r = takeFts ? fts[fi++] : vec[vi++];
    if (r && isAllowedHostUrl(r.url)) candidates.push(r);
    k++;
  }

  // 3b) Upiti po SVJEŽINI ("najnovije vijesti", "današnja događanja"…): semantička
  // sličnost tu ne pomaže (generičke riječi pogađaju stare glasnike/dokumente), pa
  // dodatno dovlačimo NAJNOVIJE dokumente (po datumu objave) iz vijesti/događanja
  // izvora i stavljamo ih NAPRIJED — rerank ih dalje presloži po relevantnosti.
  if (isRecencyQuery(query)) {
    try {
      const recent = await fetchRecentChunks(sb, config.dailyHosts, topK + 4, threshold);
      const have = new Set(candidates.map((c) => c.chunk_id));
      const fresh = recent.filter((r) => !have.has(r.chunk_id) && isAllowedHostUrl(r.url));
      candidates.unshift(...fresh);
    } catch (e) {
      console.error('[retrieval] dohvat najnovijih dokumenata nije uspio:', e);
    }
  }

  // 3c) Zdravstveni upiti ("ordinacije", "ambulante", "dom zdravlja"…): opće/nejasno
  // pitanje ne mapira se na pojedine stranice ambulanti, pa ubacujemo SVE stranice
  // Doma zdravlja (Valpovo) u izbor — rerank ih dalje presloži.
  if (isHealthQuery(query)) {
    try {
      const health = await fetchRecentChunks(sb, config.healthHosts, topK + 8, threshold);
      const have = new Set(candidates.map((c) => c.chunk_id));
      const fresh = health.filter((r) => !have.has(r.chunk_id) && isAllowedHostUrl(r.url));
      candidates.unshift(...fresh);
    } catch (e) {
      console.error('[retrieval] dohvat zdravstvenih stranica nije uspio:', e);
    }
  }

  // 4) Reranking — LLM presloži kandidate po stvarnoj relevantnosti (bira pravi
  // dokument među mnogo sličnih). Otporno na greške: vraća izvorni poredak ako zakaže.
  const ordered = await rerankChunks(query, candidates, Math.min(candidates.length, topK + 4));

  // 5) Deduplikacija po URL-u (najviše 3 isječka) + proračun konteksta, u redoslijedu
  // prioriteta (NE sortiramo po rezultatu — rerank/ispreplitanje već nose prioritet).
  const perUrl = new Map<string, number>();
  const final: RetrievedChunk[] = [];
  let budget = config.ragContextCharBudget;
  for (const r of ordered) {
    const n = perUrl.get(r.url) ?? 0;
    if (n >= 5) continue; // do 5 isječaka po dokumentu (dulji dokumenti, popisi imena…)
    if (r.text.length > budget) continue;
    perUrl.set(r.url, n + 1);
    budget -= r.text.length;
    final.push(r);
    if (final.length >= topK) break;
  }

  // 6) Kontekstualno proširenje: dodaj SUSJEDNE isječke (isti dokument, chunk_index ±1)
  // odabranih isječaka. Traženi podatak (npr. popis imena) često je odmah do naslova/uvoda
  // koji je pogođen, ali u zasebnom isječku koji sam po sebi slabo odgovara upitu.
  try {
    return await expandWithNeighbors(sb, final, budget);
  } catch (e) {
    console.error('[retrieval] kontekstualno proširenje nije uspjelo:', e);
    return final;
  }
}

/**
 * Za svaki odabrani isječak dodaje susjedne isječke istog dokumenta (chunk_index ±1),
 * unutar preostalog proračuna znakova. Dvije lagane pretrage po indeksiranim stupcima.
 */
async function expandWithNeighbors(
  sb: ReturnType<typeof supabaseAdmin>,
  chunks: RetrievedChunk[],
  budgetLeft: number,
): Promise<RetrievedChunk[]> {
  if (chunks.length === 0 || budgetLeft <= 0) return chunks;

  const ids = chunks.map((c) => c.chunk_id);
  const { data: meta, error } = await sb
    .from('dijelovi')
    .select('id, document_id, chunk_index')
    .in('id', ids);
  if (error || !meta || meta.length === 0) return chunks;

  type Meta = { id: string; document_id: string; chunk_index: number };
  const byId = new Map<string, Meta>((meta as Meta[]).map((m) => [m.id, m]));
  // Predstavnik dokumenta (za naslov/url/fetched_at susjeda) = isječak iz `chunks`.
  const parentByDoc = new Map<string, RetrievedChunk>();
  for (const c of chunks) {
    const m = byId.get(c.chunk_id);
    if (m && !parentByDoc.has(m.document_id)) parentByDoc.set(m.document_id, c);
  }

  const want = new Set<string>(); // "document_id:chunk_index"
  const docIds = new Set<string>();
  const idxSet = new Set<number>();
  for (const m of meta as Meta[]) {
    for (const d of [-1, 1]) {
      const ni = m.chunk_index + d;
      if (ni < 0) continue;
      want.add(`${m.document_id}:${ni}`);
      docIds.add(m.document_id);
      idxSet.add(ni);
    }
  }
  for (const m of meta as Meta[]) want.delete(`${m.document_id}:${m.chunk_index}`); // ne dupliciraj postojeće
  if (want.size === 0) return chunks;

  const { data: neigh, error: e2 } = await sb
    .from('dijelovi')
    .select('id, document_id, chunk_index, text')
    .in('document_id', [...docIds])
    .in('chunk_index', [...idxSet]);
  if (e2 || !neigh) return chunks;

  const have = new Set(chunks.map((c) => c.chunk_id));
  const result = [...chunks];
  let budget = budgetLeft;
  type Part = { id: string; document_id: string; chunk_index: number; text: string };
  for (const n of neigh as Part[]) {
    if (!want.has(`${n.document_id}:${n.chunk_index}`) || have.has(n.id)) continue;
    if (!n.text || n.text.length > budget) continue;
    const parent = parentByDoc.get(n.document_id);
    if (!parent) continue;
    result.push({
      chunk_id: n.id,
      text: n.text,
      title: parent.title,
      url: parent.url,
      fetched_at: parent.fetched_at,
      score: parent.score,
    });
    have.add(n.id);
    budget -= n.text.length;
  }
  return result;
}

/**
 * Iz upita zadržava samo značajne riječi (≥4 slova/znamenke) za leksičku pretragu.
 * Izbacuje česte kratke riječi (tko, su, za, na, i…) koje bi prefiks-upit učinile
 * sporim i nepreciznim. Ako ne ostane ništa, vraća izvorni upit.
 */
function lexicalQuery(query: string): string {
  const words = query
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length >= 4);
  return words.length > 0 ? words.join(' ') : query;
}

// Prepoznavanje upita "po svježini" (vijesti/događanja/danas…), za koje uz vektorsku
// pretragu dovlačimo i najnovije dokumente po datumu objave.
const RECENCY_PATTERNS = [
  'najnovij', 'novost', 'vijest', 'aktualn', 'događanj', 'događaj', 'zbivanj',
  'manifestacij', 'program', 'obavijest', 'najav', 'nadolaz', 'predstojeć', 'uskoro',
  'danas', 'sutra', 'ovaj tjedan', 'ovog tjedna', 'ovaj mjesec', 'ovih dana', 'vikend',
];
function isRecencyQuery(query: string): boolean {
  const q = query.toLowerCase();
  return RECENCY_PATTERNS.some((p) => q.includes(p));
}

// Prepoznavanje ZDRAVSTVENIH upita (ordinacije/ambulante/Dom zdravlja), za koje
// ubacujemo sve stranice Doma zdravlja za Valpovo (radno vrijeme, liječnici…).
const HEALTH_PATTERNS = [
  'ordinacij', 'ambulant', 'dom zdravlja', 'liječnik', 'lijecnik', 'doktor', 'dr. med',
  'ginekolog', 'pedijat', 'stomatolog', 'zubar', 'obiteljsk', 'opća medicin', 'opca medicin',
  'medicin', 'zdravstven', 'hitna',
];
function isHealthQuery(query: string): boolean {
  const q = query.toLowerCase();
  return HEALTH_PATTERNS.some((p) => q.includes(p));
}

/** Najnoviji dokumenti (po datumu objave) iz zadanih domena → po jedan (prvi) isječak. */
async function fetchRecentChunks(
  sb: ReturnType<typeof supabaseAdmin>,
  hosts: string[],
  limit: number,
  score: number,
): Promise<RetrievedChunk[]> {
  const { data: docs, error } = await sb
    .from('dokumenti')
    .select('id, title, url, fetched_at, published_at')
    .in('source', hosts)
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error || !docs || docs.length === 0) return [];

  const ids = docs.map((d: { id: string }) => d.id);
  const { data: parts, error: e2 } = await sb
    .from('dijelovi')
    .select('id, document_id, text, chunk_index')
    .in('document_id', ids)
    .order('chunk_index', { ascending: true });
  if (e2 || !parts) return [];

  const firstByDoc = new Map<string, { id: string; text: string }>();
  for (const p of parts as { id: string; document_id: string; text: string }[]) {
    if (!firstByDoc.has(p.document_id)) firstByDoc.set(p.document_id, { id: p.id, text: p.text });
  }

  const out: RetrievedChunk[] = [];
  for (const d of docs as { id: string; title: string; url: string; fetched_at: string }[]) {
    const p = firstByDoc.get(d.id);
    if (p) out.push({ chunk_id: p.id, text: p.text, title: d.title, url: d.url, fetched_at: d.fetched_at, score });
  }
  return out;
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
