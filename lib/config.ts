/** Središnja konfiguracija aplikacije. Izvori su ugrađeni kao zadane
 *  vrijednosti pa rade i bez ENV varijabli; ENV ih po želji nadjačava. */

function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
function float(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
function list(name: string, fallback: string[] = []): string[] {
  const v = process.env[name];
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

// Dopuštene domene izvora (gradska uprava + povezane ustanove i tvrtke)
const ALLOWED_HOSTS_DEFAULT = [
  'valpovo.hr', 'www.valpovo.hr',
  'urbanizam-valpovo.hr', 'www.urbanizam-valpovo.hr',
  'tz.valpovo.hr', 'ustanova.valpovo.hr',
  'vpc.hr', 'www.vpc.hr',
  'mojbambi.hr', 'www.mojbambi.hr',
  'oskatancic.hr', 'www.oskatancic.hr',
  'ss-valpovo.hr', 'www.ss-valpovo.hr',
  'dvd-valpovo.hr', 'www.dvd-valpovo.hr',
  'udrugamivalpovo.hr', 'www.udrugamivalpovo.hr',
  'zsuval.com', 'www.zsuval.com',
  'dzobz.hr', 'www.dzobz.hr',
  // Župni ured Valpovo (Wix stranica) — NAPOMENA: Wix sadržaj se renderira
  // JavaScriptom, pa statički dohvat može vratiti malo teksta (vidi se nakon ingestije).
  'zupavalpo.wixsite.com',
];

// Sitemapovi (nove ustanove prve, valpovo zadnji). Nepostojeći se preskaču.
const SITEMAP_URLS_DEFAULT = [
  'https://urbanizam-valpovo.hr/sitemap.xml',
  'https://tz.valpovo.hr/sitemap.xml',
  'https://ustanova.valpovo.hr/sitemap.xml',
  'https://www.vpc.hr/sitemap.xml',
  'https://mojbambi.hr/sitemap.xml',
  'https://oskatancic.hr/sitemap.xml',
  'https://ss-valpovo.hr/sitemap.xml',
  'https://www.dvd-valpovo.hr/sitemap.xml',
  'https://udrugamivalpovo.hr/sitemap.xml',
  'https://www.zsuval.com/sitemap.xml',
  'https://zupavalpo.wixsite.com/zupa-valpovo/sitemap.xml',
  'https://valpovo.hr/sitemap.xml',
];

// Pojedinačne stranice (jamče sadržaj i za sjedišta bez sitemapa)
const SEED_URLS_DEFAULT = [
  'https://urbanizam-valpovo.hr/',
  'https://tz.valpovo.hr/',
  'https://ustanova.valpovo.hr/',
  'https://www.vpc.hr/',
  'https://mojbambi.hr/',
  'https://oskatancic.hr/kontakt/',
  'https://ss-valpovo.hr/o-skoli/osobna-iskaznica-skole/opci-podaci/',
  'https://www.dvd-valpovo.hr/kontakt/',
  'https://udrugamivalpovo.hr/',
  'https://www.zsuval.com/',
  'https://www.dzobz.hr/obiteljska_grad_valpovo/',
  // Župni ured Valpovo (Wix) — sjedište i stranica „Župni ured" (kontakt, raspored misa…)
  'https://zupavalpo.wixsite.com/zupa-valpovo',
  'https://zupavalpo.wixsite.com/zupa-valpovo/%C5%BEupni-ured',
  'https://valpovo.hr/',
];

// Uzorci za preskakanje bezvrijednih URL-ova (uglavnom WordPress arhive/feedovi
// i medijske datoteke). Provjeravaju se kao podniz unutar punog URL-a, neosjetljivo
// na velika/mala slova. Nadjačivo ENV-om EXCLUDE_URL_PATTERNS (zarezom odvojeno).
const EXCLUDE_URL_PATTERNS_DEFAULT = [
  // WordPress arhive/feedovi/sistem
  '/tag/', '/page/', '/author/', '/category/', '/feed', '/wp-json',
  '?replytocom', '/attachment/', '/comment-page-', '/wp-content/uploads/',
  // Galerije i listanja (plugin-stranice bez tekstualne vrijednosti).
  // NAPOMENA: stranice događanja (/events/, /eventi/, /event/) NAMJERNO se više
  // ne isključuju — nose datume manifestacija (npr. Ljeto valpovačko).
  '/rl_gallery/', '/kino-korner/',
  '/program-category/', '/kategorija-djelatnika/',
  // Stare datumske arhive vijesti: izbacujemo godine <= 2024 (zadržavamo 2025./2026.).
  // Uzorak "re:" se tretira kao regex; traži /GODINA/ omeđenu kosim crtama.
  're:/(?:19\\d\\d|20[01]\\d|202[0-4])/',
  // Ekstenzije slika/dokumenata (PDF se NE isključuje — obrađuje se zasebno)
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.rar', '.7z', '.gz', '.mp3', '.mp4', '.avi', '.mov', '.css', '.js',
];

// Uzorci za PRESKAKANJE cijelih pod-sitemapova (provjera kao podniz pune sitemap-URL
// adrese, case-insensitive). Tako izbacujemo npr. galerije, taksonomije i, host-ciljano,
// "post" sitemap škole čije objave nemaju datum u URL-u. Nadjačivo ENV-om
// EXCLUDE_SITEMAP_PATTERNS (zarezom odvojeno).
const EXCLUDE_SITEMAP_PATTERNS_DEFAULT = [
  'rl_gallery', 'gallery-sitemap', 'product-sitemap',
  // Taksonomije i autori (kategorije/tagovi/korisnici) — njihovi su URL-ovi ionako
  // izbačeni URL-filtrom; preskačemo i same sitemape radi brzine i čistoće.
  'wp-sitemap-taxonomies', 'wp-sitemap-users',
  'category-sitemap', 'author-sitemap', 'post_tag-sitemap', 'tag-sitemap',
  // Škola ss-valpovo.hr: ~2600 objava bez datuma (nefiltrabilno po URL-u) — izbacujemo
  // njihov post-sitemap (wp-sitemap-posts-post-N.xml), a stalne stranice
  // (wp-sitemap-posts-page) zadržavamo. Pažnja: "posts-post" se NE poklapa s "posts-page".
  'ss-valpovo.hr/wp-sitemap-posts-post',
];

export const config = {
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
  claudeMaxTokens: int('CLAUDE_MAX_TOKENS', 1024),

  embeddingProvider: (process.env.EMBEDDING_PROVIDER || 'openai') as 'openai' | 'voyage',
  embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
  embeddingDim: int('EMBEDDING_DIM', 1536),

  ragTopK: int('RAG_TOP_K', 12),
  ragScoreThreshold: float('RAG_SCORE_THRESHOLD', 0.30),
  ragFtsFallback: process.env.RAG_FTS_FALLBACK !== '0',
  // FTS (tekstualni upit) je skup (rangiranje na velikom skupu) pa se koristi SAMO
  // kao rezerva: kad vektorski upit vrati manje od ovoliko rezultata. Za većinu
  // pitanja vektor vraća dovoljno pa se FTS preskače (znatno brži dohvat).
  ragFtsMinVec: int('RAG_FTS_MIN_VEC', 6),
  ragContextCharBudget: int('RAG_CONTEXT_CHAR_BUDGET', 12000),
  // Reranking: širi skup kandidata se LLM-om (Haiku) presloži po stvarnoj
  // relevantnosti — bira pravi dokument među mnogo sličnih (npr. zapisnika).
  // PREMA ZADANOM ISKLJUČEN radi brzine (dodatni LLM-poziv prije odgovora znatno
  // usporava prvi token); uključuje se s RAG_RERANK=1 ako zatreba veća točnost.
  ragRerank: process.env.RAG_RERANK === '1',
  ragRerankCandidates: int('RAG_RERANK_CANDIDATES', 24),
  rerankModel: process.env.RERANK_MODEL || 'claude-haiku-4-5',

  allowedHosts: list('ALLOWED_HOSTS', ALLOWED_HOSTS_DEFAULT),
  sitemapUrls: list('SITEMAP_URLS', SITEMAP_URLS_DEFAULT),
  seedUrls: list('SEED_URLS', SEED_URLS_DEFAULT),
  // Domene koje se osvježavaju DNEVNO (pon–sub): vijesti (valpovo.hr) i događanja
  // (Ustanova za kulturne djelatnosti, Turistička zajednica). Nove stranice iz
  // sitemapa pokupe se odmah; postojeće se ponovno provjeravaju po dailyFreshDays.
  dailyHosts: list('DAILY_HOSTS', [
    'valpovo.hr', 'www.valpovo.hr',
    'ustanova.valpovo.hr',
    'tz.valpovo.hr',
    // Župni ured (Wix): uključen u dnevni prolaz da se nove stranice pokupe brzo
    // (sutrašnjim cronom), bez čekanja nedjeljnog velikog prolaza.
    'zupavalpo.wixsite.com',
  ]),
  // Prozor svježine za DNEVNI prolaz: stranice provjerene prije <ovoliko dana se
  // ponovno dohvaćaju (1 = praktički svaki dan), da događanja/vijesti budu ažurni.
  dailyFreshDays: int('DAILY_FRESH_DAYS', 1),
  excludeUrlPatterns: list('EXCLUDE_URL_PATTERNS', EXCLUDE_URL_PATTERNS_DEFAULT),
  excludeSitemapPatterns: list('EXCLUDE_SITEMAP_PATTERNS', EXCLUDE_SITEMAP_PATTERNS_DEFAULT),
  maxChunkTokens: int('MAX_CHUNK_TOKENS', 300),
  chunkOverlapTokens: int('CHUNK_OVERLAP', 50),
  crawlDelayMs: int('CRAWL_DELAY_MS', 1000),
  ingestMaxUrls: int('INGEST_MAX_URLS', 2100),
  // INGEST_FORCE=1 preskače provjeru svježine (obradi SVE stranice ovaj prolaz) —
  // korisno za jednokratno otkrivanje svih PDF poveznica bez čekanja da stranice "ostare".
  ingestForce: process.env.INGEST_FORCE === '1',
  // Najstarija godina koju ingestiramo za OTKRIVENE PDF/slika poveznice: dokumenti
  // čija je najveća godina u URL-u manja od ove smatraju se arhivom i preskaču se
  // (npr. plan nabave 2018, raspored odvoza 2015). URL-ovi bez godine se zadržavaju.
  archiveMinYear: int('INGEST_MIN_YEAR', 2025),
  // Zaštita PDF-koraka: timeout za pdf-parse (CPU parsiranje nema vlastiti timeout
  // pa pokvaren/golem PDF može zaglaviti cijeli ingest) i gornja granica veličine.
  pdfParseTimeoutMs: int('PDF_PARSE_TIMEOUT_MS', 20_000),
  maxPdfBytes: int('MAX_PDF_BYTES', 25 * 1024 * 1024),
  // OCR fallback za skenirane (slikovne) PDF-ove bez tekstualnog sloja: pdf-parse
  // iz njih ne izvuče tekst, pa isti PDF šaljemo Claudeu (document blok) koji
  // interno radi OCR. Okida se samo kad pdf-parse vrati < ocrMinTextLen znakova,
  // i to uz stroge granice (broj stranica i veličina) radi kontrole troška.
  ocrEnabled: process.env.OCR_ENABLED !== '0',
  ocrModel: process.env.OCR_MODEL || 'claude-sonnet-4-6',
  ocrMinTextLen: int('OCR_MIN_TEXT_LEN', 80),
  ocrMaxPages: int('OCR_MAX_PAGES', 10),
  ocrMaxBytes: int('OCR_MAX_BYTES', 10 * 1024 * 1024),
  ocrMaxTokens: int('OCR_MAX_TOKENS', 4096),
  // OCR za SAMOSTALNE SLIKE (plakati/banneri, npr. datum Ljeta valpovačkog na
  // naslovnici). Otkrivaju se na HTML stranicama (extractImageLinks) i šalju
  // Claude visionu. Strogo ograničeno radi troška: filtar logotipa/ikona,
  // granica veličine, broj po stranici i UKUPNI proračun po pokretanju.
  ocrImagesEnabled: process.env.OCR_IMAGES !== '0',
  ocrImageMaxBytes: int('OCR_IMAGE_MAX_BYTES', 5 * 1024 * 1024),
  ocrImageMinDimension: int('OCR_IMAGE_MIN_DIM', 350), // min. width/height atribut (kad postoji)
  ocrImageMaxPerPage: int('OCR_IMAGE_MAX_PER_PAGE', 4),
  ocrImageMaxTotal: int('OCR_IMAGE_MAX_TOTAL', 60), // gornja granica novih slika po pokretanju

  lang: process.env.LANG_HR || process.env.LANG || 'hr',
};

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Nedostaje obavezna ENV varijabla: ${name}`);
  return v;
}
