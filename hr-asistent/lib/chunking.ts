/**
 * Dijeljenje teksta na isječke (chunking).
 *
 * Heuristika: tekst se prvo dijeli po naslovima i odlomcima (prazni redci),
 * zatim se odlomci pakiraju u isječke ciljane veličine MAX_CHUNK_TOKENS
 * (interno ~4 znaka po tokenu → zadano ~1200 znakova) s preklapanjem
 * CHUNK_OVERLAP tokena (~200 znakova) radi očuvanja konteksta na rubovima.
 */
import { config } from './config';

export interface Chunk {
  chunk_index: number;
  text: string;
  tokens_est: number;
}

const CHARS_PER_TOKEN = 4;

/** Gruba procjena broja tokena (~4 znaka po tokenu za hrvatski tekst). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Normalizacija: unicode NFC, ujednačeni razmaci, uklonjeni višestruki prazni redci. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function chunkText(
  rawText: string,
  maxTokens: number = config.maxChunkTokens,
  overlapTokens: number = config.chunkOverlapTokens,
): Chunk[] {
  const text = normalizeText(rawText);
  if (!text) return [];

  const maxChars = maxTokens * CHARS_PER_TOKEN;       // ~1200 znakova (zadano)
  const overlapChars = overlapTokens * CHARS_PER_TOKEN; // ~200 znakova (zadano)

  // 1) Podjela po odlomcima; predugačke odlomke dodatno režemo po rečenicama.
  const paragraphs = text
    .split(/\n\s*\n/)
    .flatMap((p) => (p.length > maxChars ? splitBySentences(p, maxChars) : [p]))
    .map((p) => p.trim())
    .filter(Boolean);

  // 2) Pakiranje odlomaka u isječke s preklapanjem.
  const chunks: Chunk[] = [];
  let buffer = '';

  const flush = () => {
    const t = buffer.trim();
    if (t.length > 0) {
      chunks.push({ chunk_index: chunks.length, text: t, tokens_est: estimateTokens(t) });
    }
  };

  for (const para of paragraphs) {
    if (buffer.length + para.length + 2 > maxChars && buffer.length > 0) {
      flush();
      // Preklapanje: novi isječak počinje repom prethodnoga.
      buffer = buffer.slice(Math.max(0, buffer.length - overlapChars));
    }
    buffer += (buffer ? '\n\n' : '') + para;
  }
  flush();

  return chunks;
}

function splitBySentences(paragraph: string, maxChars: number): string[] {
  const sentences = paragraph.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [paragraph];
  const parts: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if (buf.length + s.length > maxChars && buf) {
      parts.push(buf.trim());
      buf = '';
    }
    buf += s;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}
