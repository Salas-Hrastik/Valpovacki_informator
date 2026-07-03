/** Središnja konfiguracija aplikacije. Razumne zadane vrijednosti su ugrađene
 *  pa sve radi i bez ENV varijabli; ENV ih po želji nadjačava. */

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

export const config = {
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
  claudeMaxTokens: int('CLAUDE_MAX_TOKENS', 1536),

  embeddingProvider: (process.env.EMBEDDING_PROVIDER || 'openai') as 'openai' | 'voyage',
  embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
  embeddingDim: int('EMBEDDING_DIM', 1536),

  // --- Knjiga (korpus znanja) ------------------------------------------------
  // Izvor znanja NIJE web nego knjiga: datoteke u mapi KNOWLEDGE_DIR
  // (PDF s tekstualnim slojem, Markdown ili čisti tekst). Ingestija ih dijeli
  // na poglavlja/odjeljke i indeksira u Supabase (pgvector).
  bookTitle: process.env.BOOK_TITLE || 'Menadžment ljudskih potencijala',
  bookId: process.env.BOOK_ID || 'mlp', // kratka oznaka za interne reference (knjiga://mlp/…)
  knowledgeDir: process.env.KNOWLEDGE_DIR || 'knowledge',
  // Rezervna podjela kad se poglavlja ne mogu prepoznati iz naslova:
  // fiksni prozori od ovoliko stranica po odjeljku.
  pagesPerSection: int('PAGES_PER_SECTION', 6),
  // Odjeljci kraći od ovoga (znakova) spajaju se s prethodnim — naslovi bez
  // sadržaja (npr. stranica sa samo naslovom poglavlja) ne postaju zasebni dokumenti.
  minSectionChars: int('MIN_SECTION_CHARS', 400),

  // --- RAG parametri -----------------------------------------------------------
  ragTopK: int('RAG_TOP_K', 12),
  ragScoreThreshold: float('RAG_SCORE_THRESHOLD', 0.30),
  ragFtsFallback: process.env.RAG_FTS_FALLBACK !== '0',
  // FTS (tekstualni upit) je skup (rangiranje na velikom skupu) pa se koristi SAMO
  // kao rezerva: kad vektorski upit vrati manje od ovoliko rezultata.
  ragFtsMinVec: int('RAG_FTS_MIN_VEC', 6),
  ragContextCharBudget: int('RAG_CONTEXT_CHAR_BUDGET', 12000),
  // Reranking: širi skup kandidata se LLM-om (Haiku) presloži po stvarnoj
  // relevantnosti — bira pravi odjeljak među mnogo sličnih poglavlja knjige.
  // UKLJUČEN prema zadanom (mali dodatni trošak ~1 s); isključuje se s RAG_RERANK=0.
  ragRerank: process.env.RAG_RERANK !== '0',
  ragRerankCandidates: int('RAG_RERANK_CANDIDATES', 40),
  rerankModel: process.env.RERANK_MODEL || 'claude-haiku-4-5',

  // --- Chunking ------------------------------------------------------------------
  maxChunkTokens: int('MAX_CHUNK_TOKENS', 300),
  chunkOverlapTokens: int('CHUNK_OVERLAP', 50),

  // --- Zaštita PDF-koraka ----------------------------------------------------------
  // pdf-parse je sinkrono CPU-parsiranje bez vlastitog timeouta; pokvaren/golem
  // PDF ne smije zaglaviti cijelu ingestiju.
  pdfParseTimeoutMs: int('PDF_PARSE_TIMEOUT_MS', 120_000),
  maxPdfBytes: int('MAX_PDF_BYTES', 100 * 1024 * 1024),

  lang: process.env.LANG_HR || process.env.LANG || 'hr',
};

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Nedostaje obavezna ENV varijabla: ${name}`);
  return v;
}
