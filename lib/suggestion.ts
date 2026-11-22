/**
 * Provjera prijedloga sljedećeg pitanja ("💡 Možda Vas zanima: …", pravilo 16).
 *
 * Model piše prijedlog bez znanja o tome što će pretraga vratiti za to pitanje,
 * pa zna predložiti pitanje na koje Marica potom nema odgovor. Zato prije prikaza
 * pokrećemo ISTU pretragu kakva bi se pokrenula klikom na prijedlog i kratkim
 * pozivom brzog modela provjeravamo daju li pronađeni izvori potpun odgovor.
 * Kod sumnje ili pogreške prijedlog se ne prikazuje.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '@/lib/config';
import { retrieve } from '@/lib/retrieval';

/** Odgovor koji kaže da podatka nema — uz njega prijedlog nema smisla. */
const NO_DATA_RE = /ne raspolažem|nemam (?:ažurn|podat|informacij)|nisam pronaš|izvori ne (?:sadrže|navode)/i;

const CHECK_TIMEOUT_MS = 8000;
const MAX_SOURCE_CHARS = 9000;

/** Izvlači tekst pitanja iz retka prijedloga. */
export function suggestionText(line: string): string {
  return line
    .replace(/💡/u, '')
    .replace(/\*+/g, '')
    .replace(/^\s*Možda Vas zanima:?\s*/i, '')
    .trim();
}

/** true = prijedlog se smije prikazati. */
export async function verifySuggestion(suggestion: string, answerBody: string): Promise<boolean> {
  if (!suggestion || suggestion.length < 8) return false;
  if (NO_DATA_RE.test(answerBody)) return false;

  try {
    const chunks = await retrieve(suggestion);
    if (chunks.length === 0) return false;

    let budget = MAX_SOURCE_CHARS;
    const sources: string[] = [];
    for (const c of chunks) {
      if (budget <= 0) break;
      const text = c.text.slice(0, budget);
      budget -= text.length;
      sources.push(`<izvor naslov="${c.title.replace(/"/g, "'")}">\n${text}\n</izvor>`);
    }

    const anthropic = new Anthropic();
    const msg = await anthropic.messages.create(
      {
        model: config.rerankModel,
        max_tokens: 5,
        temperature: 0,
        system:
          'Procjenjujete sadrže li izvori POTPUN i KONKRETAN odgovor na pitanje građanina (konkretni podaci: ' +
          'nazivi, datumi, vremena, uvjeti, iznosi, kontakti — ne samo općenito spominjanje teme). ' +
          'Odgovorite isključivo jednom riječju: DA ili NE.',
        messages: [
          {
            role: 'user',
            content: `<izvori>\n${sources.join('\n\n')}\n</izvori>\n\nPitanje: ${suggestion}\n\nSadrže li izvori potpun i konkretan odgovor? DA ili NE.`,
          },
        ],
      },
      { timeout: CHECK_TIMEOUT_MS, maxRetries: 0 },
    );
    const out = msg.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim()
      .toUpperCase();
    return out.startsWith('DA');
  } catch (e) {
    console.error('[chat] Provjera prijedloga nije uspjela:', e instanceof Error ? e.message : e);
    return false;
  }
}
