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
      // SVI isječci (ne samo prvi): na naslovnici Doma zdravlja dežurstva su tek
      // u drugom isječku, a stranice ambulanti/ljekarni su kratke.
      const health = await fetchRecentChunks(sb, config.healthHosts, topK + 8, threshold, 4);
      const have = new Set(candidates.map((c) => c.chunk_id));
      const fresh = health.filter((r) => !have.has(r.chunk_id) && isAllowedHostUrl(r.url));
      candidates.unshift(...fresh);
    } catch (e) {
      console.error('[retrieval] dohvat zdravstvenih stranica nije uspio:', e);
    }
  }

  // 3d) Lokalne usluge (taksi, kolodvor, pošta, banke, parking, frizeri…): kratki
  // dokumenti turističkog vodiča inače ispadnu pred dugačkim PDF-ovima (prostorni
  // planovi, glasnici) koji usput spominju iste riječi — ubacujemo pogođene kategorije.
  const serviceUrls = serviceTopicUrls(query);
  if (serviceUrls.length > 0) {
    try {
      const svc = await fetchChunksByUrls(sb, serviceUrls, 6, threshold);
      const have = new Set(candidates.map((c) => c.chunk_id));
      const fresh = svc.filter((r) => !have.has(r.chunk_id) && isAllowedHostUrl(r.url));
      candidates.unshift(...fresh);
    } catch (e) {
      console.error('[retrieval] dohvat lokalnih usluga nije uspio:', e);
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

// Prepoznavanje ZDRAVSTVENIH upita (ordinacije/ambulante/Dom zdravlja, dežurstva,
// ljekarne), za koje ubacujemo sve zdravstvene stranice (config.healthHosts).
const HEALTH_PATTERNS = [
  'ordinacij', 'ambulant', 'dom zdravlja', 'liječnik', 'lijecnik', 'doktor', 'dr. med',
  'ginekolog', 'pedijat', 'stomatolog', 'zubar', 'obiteljsk', 'opća medicin', 'opca medicin',
  'medicin', 'zdravstven', 'hitna',
  // Dežurstva i ljekarne ("koji je liječnik dežuran", "kada radi apoteka")
  'dežur', 'dezur', 'ljekarn', 'apotek', 'lijek', 'recept',
];
function isHealthQuery(query: string): boolean {
  const q = query.toLowerCase();
  return HEALTH_PATTERNS.some((p) => q.includes(p));
}

// Teme LOKALNIH USLUGA → kategorije turističkog vodiča (import:turizam) i ostali
// izravni izvori. Uzorci se traže kao podniz upita (mala slova).
const SERVICE_TOPICS: { patterns: string[]; keys: string[]; urls?: string[] }[] = [
  { patterns: ['taksi', 'taxi'], keys: ['usluge.taksi'] },
  {
    patterns: ['autobus', 'kolodvor', 'vozni red', 'prijevoz'],
    keys: ['usluge.autobusni_prijevoz', 'usluge.zeljeznicki_prijevoz'],
    urls: ['https://bus.hr/autobusni-kolodvor/valpovo/autobusni-kolodvor-valpovo-informacije-vozni-red/'],
  },
  { patterns: ['vlak', 'željezni', 'zeljezni'], keys: ['usluge.zeljeznicki_prijevoz'] },
  { patterns: ['pošt', 'posta', 'paket'], keys: ['usluge.banke_i_posta'] },
  { patterns: ['bank', 'novac', 'gotovin'], keys: ['usluge.banke_i_posta', 'usluge.bankomati'] },
  { patterns: ['parkir', 'parking'], keys: ['usluge.parkiralista'] },
  { patterns: ['benzin', 'gorivo', 'pumpa', 'tankat'], keys: ['usluge.benzinske_stanice'] },
  { patterns: ['frizer', 'šišanj', 'sisanj', 'barber'], keys: ['usluge.frizeraji'] },
  { patterns: ['kozmeti', 'manikur', 'pedikur', 'uljepš', 'uljeps'], keys: ['usluge.saloni_za_uljepsavanje'] },
  { patterns: ['autoservis', 'auto servis', 'auto-servis', 'mehaničar', 'mehanicar', 'vulkanizer'], keys: ['usluge.auto_servisi'] },
  { patterns: ['trgovin', 'dućan', 'ducan', 'shopping', 'kupiti', 'kupovin'], keys: ['usluge.trgovine', 'kupovina.trgovacki_centri', 'kupovina.supermarketi', 'kupovina.specijalizirane_trgovine'] },
  { patterns: ['tržnic', 'trznic', 'opg', 'domaći proizvod', 'domaci proizvod', 'suvenir'], keys: ['kupovina.trznica', 'kupovina.opg', 'kupovina.lokalni_i_suveniri'] },
  { patterns: ['teretan', 'fitness', 'gym'], keys: ['sport.teretane'] },
  { patterns: ['apartman', 'smještaj', 'smjestaj', 'prenoć', 'prenoc', 'hotel', 'spavat', 'noćen', 'nocen'], keys: ['smjestaj.hoteli', 'smjestaj.apartmani', 'smjestaj.sobe', 'smjestaj.prenocista', 'smjestaj.ruralni_smjestaj'] },
  { patterns: ['restoran', 'kafić', 'kafic', 'caffe', 'pizz', 'pekar', 'jesti', 'ručak', 'rucak', 'večer', 'veceru', 'burger', 'fast food'], keys: ['gastronomija'] },
  { patterns: ['bicikl', 'biciklist'], keys: ['priroda.biciklizam'] },
  { patterns: ['ribolov', 'pecanj', 'pecati'], keys: ['priroda.ribolov'] },
];

/** URL-ovi dokumenata koje treba ubaciti za upit o lokalnim uslugama (bez duplikata). */
function serviceTopicUrls(query: string): string[] {
  const q = query.toLowerCase();
  const base = config.touristImportBaseUrl;
  const out = new Set<string>();
  for (const t of SERVICE_TOPICS) {
    if (!t.patterns.some((p) => q.includes(p))) continue;
    for (const k of t.keys) out.add(`${base}#${k}`);
    for (const u of t.urls ?? []) out.add(u);
  }
  return [...out];
}

/** Isječci zadanih dokumenata (po URL-u), najviše `chunksPerDoc` po dokumentu. */
async function fetchChunksByUrls(
  sb: ReturnType<typeof supabaseAdmin>,
  urls: string[],
  chunksPerDoc: number,
  score: number,
): Promise<RetrievedChunk[]> {
  const { data: docs, error } = await sb
    .from('dokumenti')
    .select('id, title, url, fetched_at')
    .in('url', urls);
  if (error || !docs || docs.length === 0) return [];

  const { data: parts, error: e2 } = await sb
    .from('dijelovi')
    .select('id, document_id, text, chunk_index')
    .in('document_id', docs.map((d: { id: string }) => d.id))
    .order('chunk_index', { ascending: true });
  if (e2 || !parts) return [];

  const byDoc = new Map<string, { id: string; text: string }[]>();
  for (const p of parts as { id: string; document_id: string; text: string }[]) {
    const arr = byDoc.get(p.document_id) ?? [];
    if (arr.length < chunksPerDoc) arr.push({ id: p.id, text: p.text });
    byDoc.set(p.document_id, arr);
  }
  // Redoslijed kao u `urls` (prva tema ima prednost).
  const order = new Map(urls.map((u, i) => [u, i]));
  const out: RetrievedChunk[] = [];
  for (const d of [...(docs as { id: string; title: string; url: string; fetched_at: string }[])].sort(
    (a, b) => (order.get(a.url) ?? 0) - (order.get(b.url) ?? 0),
  )) {
    for (const p of byDoc.get(d.id) ?? []) {
      out.push({ chunk_id: p.id, text: p.text, title: d.title, url: d.url, fetched_at: d.fetched_at, score });
    }
  }
  return out;
}

/**
 * Najnoviji dokumenti (po datumu objave) iz zadanih domena → prvih `chunksPerDoc`
 * isječaka svakog dokumenta (zadano 1 = samo prvi).
 */
async function fetchRecentChunks(
  sb: ReturnType<typeof supabaseAdmin>,
  hosts: string[],
  limit: number,
  score: number,
  chunksPerDoc = 1,
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

  // Dijelovi su poredani po chunk_index → zadržavamo prvih `chunksPerDoc` po dokumentu.
  const byDoc = new Map<string, { id: string; text: string }[]>();
  for (const p of parts as { id: string; document_id: string; text: string }[]) {
    const arr = byDoc.get(p.document_id) ?? [];
    if (arr.length < chunksPerDoc) arr.push({ id: p.id, text: p.text });
    byDoc.set(p.document_id, arr);
  }

  const out: RetrievedChunk[] = [];
  for (const d of docs as { id: string; title: string; url: string; fetched_at: string }[]) {
    for (const p of byDoc.get(d.id) ?? []) {
      out.push({ chunk_id: p.id, text: p.text, title: d.title, url: d.url, fetched_at: d.fetched_at, score });
    }
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
