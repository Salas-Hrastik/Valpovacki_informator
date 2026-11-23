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

  // 0) Tematski dohvati (koraci 3b–3e) ne ovise o embeddingu, pa kreću ODMAH i teku
  // usporedno s embeddingom i vektorskom pretragom; rezultati se niže primjenjuju
  // istim redoslijedom kao prije. Greška pojedinog dohvata ne ruši odgovor.
  const start = (label: string, run: () => Promise<RetrievedChunk[]>): Promise<RetrievedChunk[]> =>
    run().catch((e) => {
      console.error(`[retrieval] ${label} nije uspio:`, e);
      return [];
    });
  const chunksByUrlPattern = async (pattern: string, perDoc: number): Promise<RetrievedChunk[]> => {
    const { data } = await sb.from('dokumenti').select('url').ilike('url', pattern).limit(5);
    if (!data || data.length === 0) return [];
    return fetchChunksByUrls(sb, (data as { url: string }[]).map((r) => r.url), perDoc, threshold);
  };
  const serviceUrls = serviceTopicUrls(query);
  const extras = {
    recent: isRecencyQuery(query)
      ? start('dohvat najnovijih dokumenata', () => fetchRecentChunks(sb, config.dailyHosts, topK + 4, threshold))
      : null,
    // SVI isječci (ne samo prvi): na naslovnici Doma zdravlja dežurstva su tek
    // u drugom isječku, a stranice ambulanti/ljekarni su kratke.
    health: isHealthQuery(query)
      ? start('dohvat zdravstvenih stranica', () => fetchRecentChunks(sb, config.healthHosts, topK + 8, threshold, 4))
      : null,
    demo: isDemographyQuery(query)
      ? start('dohvat demografskih dokumenata', async () => {
          const { data } = await sb
            .from('dokumenti')
            .select('url')
            .or(DEMOGRAPHY_URL_PATTERNS.map((p) => `url.ilike.%${p}%`).join(','))
            .eq('source', 'valpovo.hr')
            .limit(8);
          if (!data || data.length === 0) return [];
          return fetchChunksByUrls(sb, (data as { url: string }[]).map((r) => r.url), 3, threshold);
        })
      : null,
    kom: isKomunalnaQuery(query)
      ? start('dohvat komunalnih stranica', () => fetchRecentChunks(sb, config.komunalnaHosts, topK + 6, threshold, 4))
      : null,
    cjenik: isCjenikOtpadaQuery(query)
      ? start('dohvat cjenika otpada', () => chunksByUrlPattern('%urbanizam-valpovo.hr%cjenik%', 4))
      : null,
    zupa: isZupaQuery(query)
      ? start('dohvat župnih stranica', () => chunksByUrlPattern('%zupavalpo.wixsite.com%', 4))
      : null,
    svc: serviceUrls.length > 0
      ? start('dohvat lokalnih usluga', () => fetchChunksByUrls(sb, serviceUrls, 6, threshold))
      : null,
    programs: isEventQuery(query)
      ? start('dohvat aktualnih programa manifestacija', () => fetchActiveProgramChunks(sb, threshold))
      : null,
    otpad: isOtpadQuery(query)
      ? start('dohvat rasporeda odvoza otpada', () => fetchOtpadChunks(sb, query, threshold))
      : null,
    council: isCouncilQuery(query)
      ? start('dohvat sjednica Gradskog vijeća', () => fetchLatestCouncilChunks(sb, 3, 4, threshold))
      : null,
    natjecaji: isNatjecajQuery(query)
      ? start('dohvat aktualnih natječaja', () => fetchRecentNatjecajChunks(sb, threshold))
      : null,
  };

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

  // 3b–3e) Tematski dohvati pokrenuti u koraku 0 — primjena ISTIM redoslijedom kao
  // prije (kasniji unshift ima veći prioritet; rerank ih dalje presloži):
  //  - svježina ("najnovije vijesti", "današnja događanja"…): najnoviji dokumenti iz
  //    vijesti/događanja izvora, jer generičke riječi inače pogađaju stare glasnike;
  //  - zdravstvo: sve stranice Doma zdravlja/ljekarni;
  //  - demografija: PPUG/UPU dokumenti koji vektorski ispadaju iza glasnika (idu IZA);
  //  - komunalno/urbanizam (vpc.hr, urbanizam-valpovo.hr);
  //  - cjenik odvoza otpada i župne stranice: nemaju published_at → dohvat po URL uzorku;
  //  - lokalne usluge (taksi, pošta, banke…): kratki dokumenti turističkog vodiča;
  //  - sjednice Gradskog vijeća: najnoviji pozivi/zapisnici po datumu objave.
  const applyExtra = async (p: Promise<RetrievedChunk[]> | null, front: boolean): Promise<void> => {
    if (!p) return;
    const have = new Set(candidates.map((c) => c.chunk_id));
    const fresh = (await p).filter((r) => !have.has(r.chunk_id) && isAllowedHostUrl(r.url));
    if (front) candidates.unshift(...fresh);
    else candidates.push(...fresh);
  };
  await applyExtra(extras.recent, true);
  await applyExtra(extras.health, true);
  await applyExtra(extras.demo, false);
  await applyExtra(extras.kom, true);
  await applyExtra(extras.cjenik, true);
  await applyExtra(extras.zupa, true);
  await applyExtra(extras.svc, true);
  await applyExtra(extras.council, true);
  await applyExtra(extras.natjecaji, true);
  await applyExtra(extras.programs, true);
  await applyExtra(extras.otpad, true);

  // 3f) Tekuće izdanje manifestacije: pitanje bez godine ("Kada je paljenje prve
  // adventske svijeće?") vektorski pogađa izvještaje PROŠLIH izdanja ("Advent u Valpovu
  // 2025. – …") jer oni doslovno opisuju isto, a program tekuće godine ispadne. Ako su
  // među kandidatima prošla izdanja neke serije, dovlačimo SVE isječke iste serije
  // za tekuću (i iduću) godinu na početak.
  try {
    await applyExtra(fetchCurrentEditionChunks(sb, query, candidates, threshold), true);
  } catch (e) {
    console.error('[retrieval] dohvat tekućeg izdanja nije uspio:', e);
  }

  // 4) Reranking — LLM presloži kandidate po stvarnoj relevantnosti (bira pravi
  // dokument među mnogo sličnih). Otporno na greške: vraća izvorni poredak ako zakaže.
  // 3g) Pitanje o AKTUALNIM natječajima: zatvorene natječaje (i dokumente koji ih
  // zatvaraju — otvaranje ponuda, odluka o odabiru, lista kandidata…) uklanjamo prije
  // modela, jer ih on inače usput spominje (pravilo 8a). Na pitanje o prošlim ostaju.
  if (isNatjecajQuery(query) && !isPastQuery(query)) {
    const kept = dropClosedNatjecaji(candidates);
    candidates.splice(0, candidates.length, ...kept);
  }

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

// Prepoznavanje KOMUNALNIH/URBANISTIČKIH upita, za koje ubacujemo stranice
// vpc.hr (komunalna) i urbanizam-valpovo.hr (prostorno planiranje/dozvole).
const KOMUNALNA_PATTERNS = [
  'komunal', 'komunaln', 'odvoz', 'otpad', 'smeće', 'smece', 'kontejner',
  'odlagalist', 'reciklažn', 'reciklazn', 'zeleni otok', 'recikliraj',
  'groblje', 'groblje', 'groblj', 'grobnič', 'pogrebna',
  'dimnjačar', 'dimnjačarsk', 'dimnjacarski',
  'javna rasvjet', 'uličn', 'ulicn', 'cestad', 'cesta',
  'parkiralište', 'parkiraList', 'parkiranje',
  'urbaniz', 'prostorn', 'lokacijska', 'građevinska dozvol', 'gradevin dozvol',
  'uporabna dozvol', 'legalizacij', 'ishodit dozvol',
  'GUP', 'UPU', 'DPU', 'PPUG', 'regulacijski plan', 'detaljni plan',
  'komunalni red', 'komunalni doprinos', 'komunalna naknada',
  'vpc', 'valpovačko-podravska', 'valpovacko-podravska',
];
function isKomunalnaQuery(query: string): boolean {
  const q = query.toLowerCase();
  return KOMUNALNA_PATTERNS.some((p) => q.includes(p));
}

// Upiti o župi/crkvi (raspored misa, župni ured, župnik…) — za force-load Wix stranice.
const ZUPA_PATTERNS = [
  'žup', 'zup', 'crkv', 'misa', 'mise', 'misu', 'bogosluž', 'bogosluz',
  'župnik', 'zupnik', 'kapelan', 'župni ured', 'zupni ured',
  'kateheza', 'vjeronauk', 'krštenje', 'krstenje', 'vjenčanj', 'vjencanj',
  'sakrament', 'ispovijed', 'pričest', 'krizm', 'sveta misa',
  'sveti tjedan', 'uskrs', 'blagdan', 'advent', 'božić', 'bozic',
  'župa valpovo', 'zupa valpovo',
];
function isZupaQuery(query: string): boolean {
  const q = query.toLowerCase();
  return ZUPA_PATTERNS.some((p) => q.includes(p));
}

// Upiti o cijenama odvoza komunalnog otpada/smeća — za force-load cjenik PDF-a.
const CJENIK_OTPADA_PATTERNS = [
  'cijena odvoz', 'cijene odvoz', 'koliko košta odvoz', 'koliko kosta odvoz',
  'cijena smeć', 'cijene smeć', 'cijena smec', 'koliko košta smeć', 'koliko kosta smec',
  'cijena otpad', 'cijene otpad', 'koliko košta otpad', 'koliko kosta otpad',
  'cjenik odvoz', 'cjenik otpad', 'cjenik smeć', 'cjenik smec',
  'tarifa odvoz', 'naknada za otpad', 'naknada za smeć',
];
function isCjenikOtpadaQuery(query: string): boolean {
  const q = query.toLowerCase();
  return CJENIK_OTPADA_PATTERNS.some((p) => q.includes(p));
}

// Prepoznavanje DEMOGRAFSKIH upita (stanovnici, popis, naselja…) — ključni
// chunkovi su u PPUG dokumentima koji inače ispadaju iza glasnika/zapisnika.
const DEMOGRAPHY_PATTERNS = [
  'stanovnik', 'stanovniš', 'stanovnistvo', 'stanovništv', 'popis stanovn',
  'prigradsk', 'naselje', 'naselja', 'živi u', 'zivi u', 'broji', 'broj stanovnika',
  'kućanstv', 'kucanstv', 'domacinstv', 'domaćinstv',
];
function isDemographyQuery(query: string): boolean {
  const q = query.toLowerCase();
  return DEMOGRAPHY_PATTERNS.some((p) => q.includes(p));
}

const DEMOGRAPHY_URL_PATTERNS = ['PPUG', 'ppug', 'UPU', 'upu', 'prostorni'];

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
// `obrti` = skupine iz službenog popisa obrta (import:obrti, ključ = slug naziva skupine).
const SERVICE_TOPICS: { patterns: string[]; keys: string[]; urls?: string[]; obrti?: string[] }[] = [
  { patterns: ['taksi', 'taxi'], keys: ['usluge.taksi'], obrti: ['prijevoz_i_taksi'] },
  {
    patterns: [
      'veterin', 'ljubim', 'životinj', 'zivotinj', 'mikročip', 'mikrocip', 'bjesnoć', 'bjesnoc',
      ' pas ', ' psa ', ' psu ', ' psi ', ' pse ', ' psom ', 'mačk', 'mack', 'mačak', 'macak',
      ' krav', ' svinj', ' konj', ' ovc', ' koz', ' perad', 'štene', 'stene', 'stenad',
    ],
    keys: [],
    urls: ['https://veterinarskastanicavalpovo.hr/'],
    obrti: ['kucni_ljubimci_sisanje_i_njega_pasa'],
  },
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
  { patterns: ['frizer', 'šišanj', 'sisanj', 'barber'], keys: ['usluge.frizeraji'], obrti: ['frizerski_saloni_kozmetika_i_masaza'] },
  { patterns: ['kozmeti', 'manikur', 'pedikur', 'uljepš', 'uljeps', 'masaž', 'masaz', 'nokt', 'depilac', 'trepavic', 'šmink', 'smink'], keys: ['usluge.saloni_za_uljepsavanje'], obrti: ['frizerski_saloni_kozmetika_i_masaza'] },
  { patterns: ['autoservis', 'auto servis', 'auto-servis', 'mehaničar', 'mehanicar', 'vulkaniz', ' auto ', ' auta ', ' autu ', 'automobil', 'vozil', 'limar', 'lakir', ' gume', ' guma', 'traktor', 'pomoć na cesti', 'šlep', 'slep'], keys: ['usluge.auto_servisi'], obrti: ['auto_servisi_i_vozila'] },
  { patterns: ['trgovin', 'dućan', 'ducan', 'shopping', 'kupiti', 'kupovin'], keys: ['usluge.trgovine', 'kupovina.trgovacki_centri', 'kupovina.supermarketi', 'kupovina.specijalizirane_trgovine'], obrti: ['trgovina'] },
  { patterns: ['tržnic', 'trznic', 'opg', 'domaći proizvod', 'domaci proizvod', 'suvenir'], keys: ['kupovina.trznica', 'kupovina.opg', 'kupovina.lokalni_i_suveniri'] },
  { patterns: ['teretan', 'fitness', 'gym'], keys: ['sport.teretane'] },
  { patterns: ['apartman', 'smještaj', 'smjestaj', 'prenoć', 'prenoc', 'hotel', 'spavat', 'noćen', 'nocen'], keys: ['smjestaj.hoteli', 'smjestaj.apartmani', 'smjestaj.sobe', 'smjestaj.prenocista', 'smjestaj.ruralni_smjestaj'], obrti: ['smjestaj_i_iznajmljivanje'] },
  { patterns: ['restoran', 'kafić', 'kafic', 'caffe', 'pizz', 'pekar', ' jesti', 'pojesti', 'ručak', 'rucak', ' večera ', 'večeru', 'večerat', ' vecera ', 'veceru', 'vecerat', 'burger', 'fast food', 'catering', 'ketering'], keys: ['gastronomija'], obrti: ['ugostiteljstvo_kafici_restorani_catering', 'proizvodnja_i_prodaja_hrane_pekare_mesnice_slastice'] },
  { patterns: ['bicikl', 'biciklist'], keys: ['priroda.biciklizam'] },
  // Obrti — razgovorni izrazi ("spremanje kuće", "majstor za bojler"…) koje vektorska
  // pretraga ne poveže sa službenim nazivima djelatnosti.
  { patterns: ['čišćenj', 'ciscenj', 'čistit', 'cistit', 'spreman', 'spremačic', 'spremacic', 'pospreman', 'čistačic', 'cistacic', 'pranje', 'oprati', 'odštop', 'odstop', 'odvod', 'kanalizac'], keys: [], obrti: ['ciscenje_odrzavanje_i_popravci'] },
  { patterns: ['popravak', 'popravk', 'popravit', 'servis', 'kvar', 'pokvar', 'perilic', 'hladnjak', 'frižider', 'frizider', 'kućansk', 'kucansk', 'rashladn'], keys: [], obrti: ['ciscenje_odrzavanje_i_popravci', 'elektro_vodo_i_plinoinstalacije_grijanje_i_klimatizacija'] },
  { patterns: ['vodoinst', 'vodoinstalater', 'cijev', 'slavin', 'bojler', 'curi', 'grijanj', 'plin', 'klim', 'struj', 'elektri', 'instalac', 'instalater', 'solar', 'dimnjak', 'dimnjač', 'dimnjac', 'toplinsk'], keys: [], obrti: ['elektro_vodo_i_plinoinstalacije_grijanje_i_klimatizacija'] },
  { patterns: ['građevin', 'gradevin', 'zidar', 'keramič', 'keramic', 'pločic', 'plocic', 'fasad', 'krov', 'ličil', 'licil', 'soboslik', 'bojanje zid', 'gips', 'knauf', 'suha gradnja', 'suhe gradnje', 'renov', 'adaptac', 'bager', 'iskop', 'parket', 'podov', 'izolac', 'roletn', 'rolet', 'bunar', 'kuću graditi', 'gradnj'], keys: [], obrti: ['gradevinski_i_zavrsni_radovi'] },
  { patterns: ['stolar', 'bravar', 'prozor', 'vrata', 'namještaj', 'namjestaj', 'ograd', 'zavariv', 'pvc', ' alu ', 'metal', 'tokar', 'cnc'], keys: [], obrti: ['stolarija_bravarija_i_obrada_metala'] },
  { patterns: ['selidb', 'seliti', 'dostav', 'kombi', 'prijevoz teret', 'kamion'], keys: [], obrti: ['prijevoz_i_taksi'] },
  { patterns: ['računovod', 'racunovod', 'knjigovod', 'savjetov', 'prijevod', 'prevodit', 'prevođ', 'prevod', 'osiguranj', 'konzalt', 'consult', 'zapošljav', 'zaposljav'], keys: [], obrti: ['racunovodstvo_savjetovanje_i_poslovne_usluge'] },
  { patterns: ['web stranic', 'izrada web', 'računal', 'racunal', 'laptop', 'programer', 'programir', 'aplikacij', 'dizajn', 'marketing', 'reklam', 'fotograf', 'snimanj', 'video', 'tisak', 'print', 'društvene mreže', 'drustvene mreze', 'informatič', 'informatic', 'ai asistent', 'chatbot'], keys: [], obrti: ['informatika_dizajn_marketing_i_mediji'] },
  { patterns: ['glazb', 'bend', 'svirk', 'pjevač', 'pjevac', ' dj ', 'animator', 'rođendan', 'rodendan', 'proslav', 'zabav', 'dekor', 'rukotvor', 'umjetni', 'tambur'], keys: [], obrti: ['kreativne_djelatnosti_umjetnost_glazba_i_zabava'] },
  { patterns: ['trener', 'trening', 'poduk', 'instrukc', 'tečaj', 'tecaj', 'vježb', 'vjezb', 'joga', 'pilates', 'čuvanje djece', 'cuvanje djece', 'dadilj', 'čuvalic', 'cuvalic', 'sport'], keys: [], obrti: ['sport_rekreacija_i_poduka'] },
  { patterns: ['fizioterap', 'terapij', 'rehabilit', 'leđa', 'ledja'], keys: [], obrti: ['zdravlje_i_terapija', 'frizerski_saloni_kozmetika_i_masaza'] },
  { patterns: ['cvijeć', 'cvijec', 'cvjeć', 'cvjec', 'buket', 'grobov', 'grobnic', 'vijenac', 'vijenc', 'klesar', 'spomenik', 'pogreb'], keys: [], obrti: ['cvjecarne_i_odrzavanje_grobova'] },
  { patterns: ['krojač', 'krojac', 'šivanj', 'sivanj', 'sašiti', 'sasiti', 'zlatar', 'urar', 'sat ', 'optičar', 'opticar', 'naočal', 'naocal', 'ključ', 'kljuc', 'postolar', 'cipel', 'vez '], keys: [], obrti: ['krojaci_zlatari_opticari_i_obrtnicke_usluge'] },
  { patterns: ['vrtlar', ' vrt ', ' vrta ', ' vrtu ', 'košnj', 'kosnj', 'kositi', 'travnjak', 'trava', 'drveć', 'drvec', 'orezivanj', 'okoliš', 'okolis', 'poljopriv'], keys: [], obrti: ['poljoprivreda_vrtlarstvo_i_sumarstvo'] },
  { patterns: ['torte', 'torta', 'kolač', 'kolac', 'slastic', 'mesnic', 'mesar', 'pekarn', 'kruh', ' med ', 'meda '], keys: [], obrti: ['proizvodnja_i_prodaja_hrane_pekare_mesnice_slastice'] },
  { patterns: ['ribolov', 'pecanj', 'pecati'], keys: ['priroda.ribolov'] },
  // Pravo na pristup informacijama — stranica Grada s kontaktom službenika (inače
  // vektor bira istoimene stranice škola i ustanova ili sam tekst zakona).
  { patterns: ['pristup informacij', 'pristupa informacij', 'pravo na pristup', 'službenik za informiranje', 'sluzbenik za informiranje', 'ponovnu uporabu informacij', 'ponovna uporaba informacij'], keys: [], urls: ['https://valpovo.hr/pristup-informacijama/'] },
  // Upis u vrtić — gradski DV Maza pokrivaju odluke u glasnicima (vektor), a privatni
  // DV Moj Bambi ima zasebnu stranicu upisa.
  { patterns: ['vrtić', 'vrtic', 'upis djeteta', 'upisati dijete', 'predškol', 'predskol'], keys: [], urls: ['https://mojbambi.hr/upisi/'] },
];

/** URL-ovi dokumenata koje treba ubaciti za upit o lokalnim uslugama (bez duplikata). */
function serviceTopicUrls(query: string): string[] {
  // Razmaci oko upita i umjesto interpunkcije → uzorci s razmacima (' pas ') hvataju cijele riječi.
  const q = ` ${query.toLowerCase().replace(/[.,!?;:()"]/g, ' ')} `;
  const base = config.touristImportBaseUrl;
  const out = new Set<string>();
  for (const t of SERVICE_TOPICS) {
    if (!t.patterns.some((p) => q.includes(p))) continue;
    for (const k of t.keys) out.add(`${base}#${k}`);
    for (const u of t.urls ?? []) out.add(u);
    for (const o of t.obrti ?? []) out.add(`${config.obrtiImportBaseUrl}#${o}`);
  }
  return [...out];
}

const COUNCIL_PATTERNS = ['gradsko vijeć', 'gradskog vijeć', 'gradskom vijeć', 'gradsko vijec', 'gradskog vijec', 'gradskom vijec', 'sjednic', 'dnevni red', 'dnevnom redu', 'vijećnik', 'vijecnik'];

function isCouncilQuery(query: string): boolean {
  const q = query.toLowerCase();
  return COUNCIL_PATTERNS.some((p) => q.includes(p));
}

/** Najnoviji pozivi i zapisnici sjednica Gradskog vijeća (bez odbora/komisija), po datumu objave. */
async function fetchLatestCouncilChunks(
  sb: ReturnType<typeof supabaseAdmin>,
  limit: number,
  chunksPerDoc: number,
  score: number,
): Promise<RetrievedChunk[]> {
  const { data: docs, error } = await sb
    .from('dokumenti')
    .select('url, published_at')
    .eq('source', 'valpovo.hr')
    .like('url', '%/wp-content/uploads/%')
    .or('url.ilike.%poziv%sjednic%,url.ilike.%zapisnik%sj%')
    .not('url', 'ilike', '%odbor%')
    .not('url', 'ilike', '%komisij%')
    .not('published_at', 'is', null)
    .order('published_at', { ascending: false })
    .limit(limit);
  if (error || !docs || docs.length === 0) return [];
  return fetchChunksByUrls(sb, (docs as { url: string }[]).map((d) => d.url), chunksPerDoc, score);
}

// Upiti o NATJEČAJIMA / javnim pozivima ("ima li raspisanog natječaja", "natječaj za posao"):
// vektor pogađa stare natječaje (isti tekst svake godine), pa dovlačimo i natječaje
// objavljene u zadnjih NATJECAJ_DAYS dana, najnovije prvo. Rok procjenjuje model (pravilo 7b).
const NATJECAJ_PATTERNS = ['natječa', 'natjeca', 'javni poziv', 'javnog poziva', 'javne pozive', 'oglas za', 'zapošljavanj', 'zaposljavanj'];
const NATJECAJ_DAYS = 120;

function isNatjecajQuery(query: string): boolean {
  const q = query.toLowerCase();
  return NATJECAJ_PATTERNS.some((p) => q.includes(p));
}

// Pitanje izričito o prošlosti ("koji su natječaji bili", "rezultati natječaja").
const PAST_RE = /\bbil[aieo]?\b|ranij|prošl|prosl|zatvoren|rezultat|odabran|odabir|ishod|tko je dobio/i;
function isPastQuery(query: string): boolean {
  return PAST_RE.test(query);
}

// Dokumenti koji označavaju da je natječaj ZATVOREN.
const CLOSING_RE = /otvaranj\w* ponud|odluk\w* o odabir|lista kandidat|rezultat|obavijest\w* kandidat|poziv\w* (?:i obavijest )?kandidat|izvjesc\w* o proveden/;
const KEY_STOP = new Set(
  ('javno javni javnog javne otvaranje otvaranja ponuda ponude pristiglih pristigle natjecaj natjecaja natjecaju ' +
    'odluka odluke odluku odabiru odabir lista liste kandidata kandidatima koji rezultati rezultat obavijest poziv ' +
    'za na iz od do sa pdf compressed procelnik povjerenstvo gradonacelnik provedenom izvjesce')
    .split(' '),
);
const foldKey = (s: string) => foldHr(s).replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Uklanja dokumente koji zatvaraju natječaj i natječaje na koje se odnose (prepoznaje ih
 * po zajedničkim ključnim riječima naziva datoteke, npr. "advent valpovu 2026").
 */
function dropClosedNatjecaji(chunks: RetrievedChunk[]): RetrievedChunk[] {
  const closingUrls = new Set<string>();
  const closedKeys: string[][] = [];
  for (const c of chunks) {
    if (!CLOSING_RE.test(foldKey(`${c.title} ${c.url}`))) continue;
    closingUrls.add(c.url);
    const file = decodeURIComponent(c.url.split('/').filter(Boolean).pop() ?? '').replace(/\.pdf$/i, '');
    const keys = foldKey(file).split(' ').filter((t) => t.length > 2 && !KEY_STOP.has(t));
    if (keys.length >= 2) closedKeys.push(keys);
  }
  if (closingUrls.size === 0) return chunks;
  return chunks.filter((c) => {
    if (closingUrls.has(c.url)) return false;
    const hay = ` ${foldKey(`${c.title} ${decodeURIComponent(c.url)}`)} `;
    return !closedKeys.some((keys) => keys.every((k) => hay.includes(` ${k} `)));
  });
}

async function fetchRecentNatjecajChunks(
  sb: ReturnType<typeof supabaseAdmin>,
  score: number,
): Promise<RetrievedChunk[]> {
  const since = new Date(Date.now() - NATJECAJ_DAYS * 86400000).toISOString();
  const { data: docs, error } = await sb
    .from('dokumenti')
    .select('url, published_at')
    .or('title.ilike.%natječa%,title.ilike.%natjeca%,url.ilike.%natjecaj%,url.ilike.%javni-poziv%,title.ilike.%javni poziv%')
    .gte('published_at', since)
    .order('published_at', { ascending: false })
    .limit(12);
  if (error || !docs || docs.length === 0) return [];
  return fetchChunksByUrls(sb, (docs as { url: string }[]).map((d) => d.url), 2, score);
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

const foldHr = (s: string) =>
  s.toLowerCase().replace(/[čć]/g, 'c').replace(/š/g, 's').replace(/ž/g, 'z').replace(/đ/g, 'd');

/**
 * Sezonske teme → serija manifestacije čije tekuće izdanje uvijek dohvaćamo. Riječi kao
 * "jaslice" ili "doček" vektorski pogađaju posve druge dokumente (vrtići, škole), a
 * nalaze se samo u programu Adventa.
 */
const SEASONAL_SERIES: { patterns: string[]; series: string }[] = [
  {
    patterns: [
      'advent', 'božić', 'bozic', 'jaslic', 'djed mraz', 'djeda mraz', 'djed božićnjak', 'djeda božićnjak',
      'sv. nikol', 'svetog nikol', 'sveti nikola', 'nikolin', 'lampion', 'klizal', 'doček', 'docek',
      'nova godin', 'nove godine', 'novu godinu', 'novogodiš', 'novogodis', 'silvestr', 'vatromet', 'svijeć', 'svijec',
    ],
    series: 'advent u valpovu',
  },
];

// Upiti o DOGAĐANJIMA (koncert, predstava, izložba…): uz vektorske rezultate dovlačimo
// programe manifestacija koje su u tijeku ili uskoro počinju (npr. Advent), jer vektor
// inače pogađa pojedinačne, često već održane događaje.
const EVENT_PATTERNS = [
  'koncert', 'predstav', 'izložb', 'izlozb', 'radionic', 'nastup', 'priredb', 'kino', 'film',
  'festival', 'sajam', 'svirk', 'događ', 'dogad', 'manifestac', 'zabav', 'kazališ', 'kazalis',
  'predavanj', 'tribin', 'za djecu', 'što se događa', 'sto se dogada', 'izlaz', 'program',
];
// …ali samo kad pitanje traži VRIJEME (kada, uskoro, sljedeći…); "Koje događaje
// organizira ustanova?" ostaje vektorskim izvorima ustanove.
const WHEN_PATTERNS = [
  'kada', 'kad ', 'kad?', 'uskoro', 'sljedeć', 'sljedec', 'idući', 'iduci', 'nadolaz', 'predstojeć',
  'predstojec', 'ima li', 'imali', 'danas', 'sutra', 'vikend', 'ovaj tjedan', 'ovog tjedna',
  'ovaj mjesec', 'ovog mjeseca', 'studen', 'prosin', 'siječ', 'sijec', 'što se događa', 'sto se dogada',
  'gdje mogu', 'kamo', 'u koliko sati',
];
function isEventQuery(query: string): boolean {
  const q = ` ${query.toLowerCase()} `;
  return EVENT_PATTERNS.some((p) => q.includes(p)) && WHEN_PATTERNS.some((p) => q.includes(p));
}

const PROGRAM_RANGE_RE =
  /\((\d{1,2})\.\s*(\d{1,2})\.\s*((?:19|20)\d{2})\.?\s*[–—-]\s*(\d{1,2})\.\s*(\d{1,2})\.\s*((?:19|20)\d{2})\.?\)/;

/**
 * Programi manifestacija s rasponom datuma u naslovu ("… (28.11.2026. – 01.01.2027.)")
 * koji su u tijeku ili počinju u idućih 45 dana → svi isječci (do 12), najviše 3 programa.
 */
async function fetchActiveProgramChunks(
  sb: ReturnType<typeof supabaseAdmin>,
  score: number,
): Promise<RetrievedChunk[]> {
  const year = currentYearHr();
  const { data } = await sb
    .from('dokumenti')
    .select('url, title')
    .ilike('title', '%(%.%.%)%')
    .or(`title.ilike.%${year}%,title.ilike.%${year + 1}%`)
    .limit(100);
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Zagreb' }));
  today.setHours(0, 0, 0, 0);
  const horizon = today.getTime() + 45 * 24 * 60 * 60 * 1000;
  const active: { url: string; start: number }[] = [];
  for (const d of (data ?? []) as { url: string; title: string }[]) {
    const m = d.title.match(PROGRAM_RANGE_RE);
    if (!m) continue;
    const start = new Date(+m[3], +m[2] - 1, +m[1]).getTime();
    const end = new Date(+m[6], +m[5] - 1, +m[4]).getTime();
    if (end >= today.getTime() && start <= horizon) active.push({ url: d.url, start });
  }
  if (active.length === 0) return [];
  active.sort((a, b) => a.start - b.start);
  return fetchChunksByUrls(sb, [...new Set(active.map((a) => a.url))].slice(0, 3), 12, score);
}

// Odvoz otpada (glomazni, raspored po naseljima): aktualni raspored Urbanizma za
// tekuću godinu (PDF-ovi po polugodištima) + obavijesti o glomaznom otpadu.
const OTPAD_PATTERNS = ['glomazn', 'odvoz', 'smeć', 'smec', 'otpad', 'reciklaž', 'reciklaz', 'kontejner', 'kanta za'];
function isOtpadQuery(query: string): boolean {
  const q = query.toLowerCase();
  return OTPAD_PATTERNS.some((p) => q.includes(p));
}

async function fetchOtpadChunks(
  sb: ReturnType<typeof supabaseAdmin>,
  query: string,
  score: number,
): Promise<RetrievedChunk[]> {
  const year = currentYearHr();
  const [sched, bulky] = await Promise.all([
    sb.from('dokumenti').select('url').ilike('url', `%urbanizam-valpovo.hr%aspored-odvoza%${year}%`)
      .not('url', 'ilike', '%koska%').order('url', { ascending: false }).limit(3),
    // Obavijesti o glomaznom otpadu (način prijave, telefon) — samo za pitanja o glomaznom.
    query.toLowerCase().includes('glomazn')
      ? sb.from('dokumenti').select('url').ilike('url', '%urbanizam-valpovo.hr%glomazn%')
          .order('published_at', { ascending: false, nullsFirst: false }).limit(2)
      : Promise.resolve({ data: [] as { url: string }[] }),
  ]);
  const urls = (r: { data: unknown }) => ((r.data ?? []) as { url: string }[]).map((d) => d.url);
  return [
    ...(await fetchChunksByUrls(sb, urls(bulky), 2, score)),
    ...(await fetchChunksByUrls(sb, urls(sched), 4, score)),
  ];
}

/** Tekuća godina u Hrvatskoj (Europe/Zagreb). */
function currentYearHr(): number {
  return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zagreb', year: 'numeric' }).format(new Date()), 10);
}

/**
 * Serije "naziv + godina" (npr. "Advent u Valpovu 2025.") među kandidatima koje se
 * pojavljuju s PROŠLOM godinom → svi isječci dokumenata iste serije za tekuću/iduću
 * godinu (naslov ili URL sadrži naziv serije i godinu) — i kad je neki nebitan isječak
 * tekućeg izdanja već među kandidatima. Ništa ako pitanje navodi godinu.
 */
async function fetchCurrentEditionChunks(
  sb: ReturnType<typeof supabaseAdmin>,
  query: string,
  candidates: RetrievedChunk[],
  score: number,
): Promise<RetrievedChunk[]> {
  if (/\b(19|20)\d{2}\b/.test(query)) return [];
  const year = currentYearHr();
  const q = query.toLowerCase();
  const seasonal = SEASONAL_SERIES.filter((t) => t.patterns.some((p) => q.includes(p))).map((t) => t.series);
  const series = new Map<string, { old: number }>();
  for (const c of candidates) {
    const m = (c.title || '').match(/^\s*(.{4,60}?)\s+((?:19|20)\d{2})\b/u);
    if (!m) continue;
    const name = m[1].replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (name.split(' ').filter((w) => w.length >= 3).length === 0) continue;
    const prev = series.get(name) ?? { old: 0 };
    series.set(name, { old: prev.old + (parseInt(m[2], 10) < year ? 1 : 0) });
  }
  const stale = [...series.entries()]
    .filter(([, v]) => v.old > 0)
    .sort((a, b) => b[1].old - a[1].old)
    .slice(0, 2)
    .map(([name]) => name);
  for (const name of seasonal) if (!stale.includes(name)) stale.unshift(name);
  if (stale.length === 0) return [];

  const urls = new Set<string>();
  for (const name of stale) {
    const slug = foldHr(name).replace(/ /g, '-');
    for (const y of [year, year + 1]) {
      const [byTitle, byUrl] = await Promise.all([
        sb.from('dokumenti').select('url').ilike('title', `%${name}%${y}%`).limit(4),
        sb.from('dokumenti').select('url').ilike('url', `%${slug}%${y}%`).limit(4),
      ]);
      for (const r of [...(byTitle.data ?? []), ...(byUrl.data ?? [])] as { url: string }[]) urls.add(r.url);
    }
  }
  if (urls.size === 0) return [];
  // Svi isječci (do 12): program je dug, a traženi dan (npr. lampionada u prosincu)
  // zna biti duboko u dokumentu — pravi isječak bira reranker.
  return fetchChunksByUrls(sb, [...urls].slice(0, 4), 12, score);
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
