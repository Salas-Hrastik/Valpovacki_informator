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
  'dvorac.hr', 'www.dvorac.hr',
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
];

// Sitemapovi (nove ustanove prve, valpovo zadnji). Nepostojeći se preskaču.
const SITEMAP_URLS_DEFAULT = [
  'https://dvorac.hr/sitemap.xml',
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
  'https://valpovo.hr/sitemap.xml',
];

// Pojedinačne stranice (jamče sadržaj i za sjedišta bez sitemapa)
const SEED_URLS_DEFAULT = [
  'https://www.dvorac.hr/',
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
  'https://valpovo.hr/',
];

export const config = {
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
  claudeMaxTokens: int('CLAUDE_MAX_TOKENS', 1024),

  embeddingProvider: (process.env.EMBEDDING_PROVIDER || 'openai') as 'openai' | 'voyage',
  embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
  embeddingDim: int('EMBEDDING_DIM', 1536),

  ragTopK: int('RAG_TOP_K', 8),
  ragScoreThreshold: float('RAG_SCORE_THRESHOLD', 0.35),
  ragFtsFallback: process.env.RAG_FTS_FALLBACK !== '0',
  ragContextCharBudget: int('RAG_CONTEXT_CHAR_BUDGET', 12000),

  allowedHosts: list('ALLOWED_HOSTS', ALLOWED_HOSTS_DEFAULT),
  sitemapUrls: list('SITEMAP_URLS', SITEMAP_URLS_DEFAULT),
  seedUrls: list('SEED_URLS', SEED_URLS_DEFAULT),
  maxChunkTokens: int('MAX_CHUNK_TOKENS', 300),
  chunkOverlapTokens: int('CHUNK_OVERLAP', 50),
  crawlDelayMs: int('CRAWL_DELAY_MS', 1000),
  ingestMaxUrls: int('INGEST_MAX_URLS', 1500),

  lang: process.env.LANG_HR || process.env.LANG || 'hr',
};

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Nedostaje obavezna ENV varijabla: ${name}`);
  return v;
}
