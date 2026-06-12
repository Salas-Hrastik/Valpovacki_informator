/**
 * Središnja konfiguracija aplikacije — sve ENV varijable čitaju se ovdje.
 * Vrijednosti i objašnjenja: vidi .env.example
 */

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

export const config = {
  // Claude — generiranje odgovora.
  // Napomena: "claude-3.5-sonnet" iz izvorne specifikacije povučen je iz
  // upotrebe (listopad 2025.); zadana zamjena je claude-sonnet-4-6.
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
  claudeMaxTokens: int('CLAUDE_MAX_TOKENS', 1024),

  // Embeddingi — Anthropic ne nudi embedding API ("claude-embed-v1" ne
  // postoji); podržani su 'openai' (zadano) i 'voyage'.
  embeddingProvider: (process.env.EMBEDDING_PROVIDER || 'openai') as 'openai' | 'voyage',
  embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
  // MORA odgovarati vector(DIM) u supabase/schema.sql!
  embeddingDim: int('EMBEDDING_DIM', 1536),

  // RAG parametri
  ragTopK: int('RAG_TOP_K', 8),
  ragScoreThreshold: float('RAG_SCORE_THRESHOLD', 0.35),
  ragFtsFallback: process.env.RAG_FTS_FALLBACK !== '0',
  ragContextCharBudget: int('RAG_CONTEXT_CHAR_BUDGET', 12000),

  // Ingestija
  allowedHosts: list('ALLOWED_HOSTS', ['valpovo.hr', 'www.valpovo.hr']),
  sitemapUrls: list('SITEMAP_URLS'),
  seedUrls: list('SEED_URLS'),
  maxChunkTokens: int('MAX_CHUNK_TOKENS', 300),
  chunkOverlapTokens: int('CHUNK_OVERLAP', 50),
  crawlDelayMs: int('CRAWL_DELAY_MS', 1000),
  ingestMaxUrls: int('INGEST_MAX_URLS', 200),

  lang: process.env.LANG_HR || process.env.LANG || 'hr',
};

/** Dohvaća obaveznu ENV varijablu; baca grešku ako nedostaje. */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Nedostaje obavezna ENV varijabla: ${name}`);
  return v;
}
