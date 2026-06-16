/**
 * OCR fallback za skenirane (slikovne) PDF-ove.
 *
 * Mnogi dokumenti gradske/komunalne uprave (cjenici, odluke o parkiranju,
 * obavijesti) objavljeni su kao SKENIRANI PDF — slika stranice bez tekstualnog
 * sloja. `pdf-parse` iz takvih dokumenata ne izvuče tekst, pa bi inače završili
 * prazni i bili preskočeni. Ovdje isti PDF šaljemo Claudeu kao `document` blok;
 * model interno radi OCR i vraća prepisani tekst (izvrsno podržava hrvatski).
 *
 * Poziva se SAMO kao fallback (vidi extractFromPdf) i uz stroge granice
 * (broj stranica, veličina) kako bi trošak ostao zanemariv.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';

const OCR_PROMPT =
  'Ovo je skenirani dokument. Prepiši TOČNO sav vidljivi tekst iz dokumenta, ' +
  'redom kako se pojavljuje, zadržavajući odlomke i retke. Uključi tablice kao ' +
  'običan tekst (vrijednosti odvojene razmacima). NE dodaji komentare, naslove ' +
  'niti objašnjenja — vrati isključivo prepisani tekst. Ako u dokumentu nema ' +
  'čitljivog teksta, vrati prazan odgovor.';

/**
 * Šalje PDF Claudeu na OCR i vraća prepisani tekst (može biti prazan string
 * ako dokument nema čitljivog teksta). Baca grešku ako poziv ne uspije —
 * pozivatelj to tretira kao neuspjeli dokument i nastavlja s ostalima.
 */
export async function ocrPdf(buffer: Buffer, url: string): Promise<string> {
  const anthropic = new Anthropic(); // ANTHROPIC_API_KEY iz okoline (kao u rerank.ts)
  const msg = await anthropic.messages.create({
    model: config.ocrModel,
    max_tokens: config.ocrMaxTokens,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: buffer.toString('base64'),
            },
          },
          { type: 'text', text: OCR_PROMPT },
        ],
      },
    ],
  });

  const text = msg.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();

  console.log(`[ocr] ${url} — ${text.length} znakova (model: ${config.ocrModel})`);
  return text;
}
