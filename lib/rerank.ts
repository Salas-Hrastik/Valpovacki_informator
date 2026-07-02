/**
 * Reranking dohvaćenih isječaka — brzi LLM (Claude Haiku) presloži kandidate po
 * stvarnoj relevantnosti za pitanje. Ključno kad u korpusu ima mnogo SLIČNIH
 * dokumenata (npr. zapisnici sjednica) pa vektor/FTS izvuku pravi tip, ali ne i
 * baš onaj koji sadrži odgovor.
 *
 * Otporno na greške: ako rerank zakaže (nema ključa, timeout…), vraća se izvorni
 * poredak — dohvat nikad ne pada zbog reranka.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config';
import type { RetrievedChunk } from './retrieval';

const SNIPPET_CHARS = 350; // koliko teksta po kandidatu šaljemo rerankeru (kraće = brži rerank)
const RERANK_TIMEOUT_MS = 8000; // gornja granica čekanja; nakon toga izvorni poredak

export async function rerankChunks(
  query: string,
  chunks: RetrievedChunk[],
  topN: number,
): Promise<RetrievedChunk[]> {
  if (!config.ragRerank || chunks.length <= topN) return chunks.slice(0, topN);

  try {
    const list = chunks
      .map((c, i) => `[${i}] ${c.title}\n${c.text.slice(0, SNIPPET_CHARS)}`)
      .join('\n\n');

    const anthropic = new Anthropic(); // ANTHROPIC_API_KEY iz okoline
    const msg = await anthropic.messages.create(
      {
        model: config.rerankModel,
        max_tokens: 80,
        system:
          'Ti odabireš izvore za odgovor na pitanje građanina. Na temelju pitanja vrati ' +
          `indekse isječaka koji NAJBOLJE sadrže odgovor, najrelevantniji prvi, najviše ${topN}. ` +
          'Odgovori ISKLJUČIVO zarezom odvojenim indeksima (npr. "3,0,7"). Bez objašnjenja.',
        messages: [{ role: 'user', content: `Pitanje: ${query}\n\nIsječci:\n${list}` }],
      },
      // Rerank je "best effort": kratak timeout i bez ponavljanja da ne usporava
      // i ne visi odgovor; ako padne, niže se vraća izvorni poredak.
      { timeout: RERANK_TIMEOUT_MS, maxRetries: 0 },
    );

    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const ids = [...text.matchAll(/\d+/g)]
      .map((m) => parseInt(m[0], 10))
      .filter((i) => Number.isInteger(i) && i >= 0 && i < chunks.length);
    if (ids.length === 0) return chunks.slice(0, topN);

    const seen = new Set<number>();
    const ranked: RetrievedChunk[] = [];
    for (const i of ids) {
      if (!seen.has(i)) {
        seen.add(i);
        ranked.push(chunks[i]);
      }
    }
    // Dodaj preostale (neodabrane) na kraj radi pokrivenosti, pa skrati na topN.
    for (let i = 0; i < chunks.length; i++) {
      if (!seen.has(i)) ranked.push(chunks[i]);
    }
    return ranked.slice(0, topN);
  } catch (e) {
    console.error('[rerank] greška — koristim izvorni poredak:', e);
    return chunks.slice(0, topN);
  }
}
