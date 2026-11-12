/**
 * Jednokratni unos ručno prikupljenih podataka u bazu znanja.
 * Pokretanje: npx tsx scripts/insert-manual-doc.ts
 *
 * Koristi isti RPC (upsert_document_with_chunks) kao i redoviti ingest,
 * uz virtualnu URL shemu zupavalpo.wixsite.com/zupa-valpovo#<key> koja je
 * već u allowedHosts pa retrieval može posluživati ove dokumente.
 */
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Učitavanje .env.local bez zewnętrzne ovisnosti (isti pattern kao scripts/ingest.ts)
function loadEnvLocal(): void {
  const file = resolve(process.cwd(), '.env.local');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined)
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvLocal();

import { chunkText } from '../lib/chunking';
import { embedTexts, l2norm } from '../lib/embeddings';
import { supabaseAdmin } from '../lib/supabase';

// ─── RUČNO UNESENI DOKUMENTI ──────────────────────────────────────────────────

const MANUAL_DOCS: { key: string; title: string; text: string }[] = [
  {
    key: 'zupa-harkanovci',
    title: 'Župa Snježne Gospe, Harkanovci',
    text: `
Župa Snježne Gospe, Harkanovci

Župa Snježne Gospe pokriva tri mjesta u općini Valpovo: Harkanovci, Ivanovci i Zelčin.
Župna crkva posvećena je Snježnoj Gospi.

Adresa: Školska 1, 31227 Zelčin
Telefon: 031/678-080
E-mail: zupaharkanovci@gmail.com
IBAN: HR36 2500 0091 1020 4396 0
Facebook: https://www.facebook.com/p/Župa-Snježne-Gospe-Harkanovci-100057552159345/

RASPORED SVETIH MISA (redoviti tjedni raspored):
- Nedjelja:
  • 8:30 — Zelčin
  • 9:45 — Ivanovci
  • 11:00 — Harkanovci (pro populo)
- Ponedjeljak: 8:00
- Utorak, Srijeda, Četvrtak, Petak, Subota: 18:00

ŽUPNI URED:
Ured je otvoren svaki dan određeno vrijeme prije i poslije mise.
Za dolazak se dogovorite telefonom ili e-mailom.
Ulaz u ured je sa strane Školske ulice.
Lučko (mesečne intencije) ne treba prijavljivati u sakristiji nego u župnom uredu.

KATEHEZA:
Susreti prvopričesnika i krizmanika subotom u 9:00 u župnoj kući u Harkanovcima.

SVETIŠTE MAJKE NOVOG SAVEZA:
- Subota (svaka druga u mjesecu): Krunica za muškarce u 8:00, nakon toga zajednički ručak.
- Četvrtak u 20:00: Krunica za Domovinu (bratovština „Marijanski savjet za domovinu").
- Nedjelja u 14:00: Svetište otvoreno za osobnu molitvu i pobožnost.

Za informacije o sakramentima (krštenje, vjenčanje, krizme, pričest, sprovod/pogreb)
obratite se župnom uredu telefonom, e-mailom ili osobno.
`.trim(),
  },
];

// ─── BAZA URL (mora biti u allowedHosts) ──────────────────────────────────────

const BASE_URL = 'https://zupavalpo.wixsite.com/zupa-valpovo';

// ─── UPSERT ───────────────────────────────────────────────────────────────────

async function main() {
  const sb = supabaseAdmin();

  for (const doc of MANUAL_DOCS) {
    const url = `${BASE_URL}#${doc.key}`;
    const hash = createHash('sha256').update(doc.text).digest('hex');

    const chunks = chunkText(doc.text);
    const vectors = await embedTexts(chunks.map((c) => `${doc.title}\n\n${c.text}`));

    const { error } = await sb.rpc('upsert_document_with_chunks', {
      p_doc: {
        url,
        title: doc.title,
        source: 'zupavalpo.wixsite.com',
        lang: 'hr',
        municipality: 'Valpovo',
        content_text: doc.text,
        content_hash: hash,
        published_at: '',
      },
      p_chunks: chunks.map((c, i) => ({
        chunk_index: c.chunk_index,
        text: c.text,
        tokens_est: c.tokens_est,
        embedding: vectors[i],
        norm: l2norm(vectors[i]),
      })),
    });

    if (error) {
      console.error(`GREŠKA: ${url}\n`, error.message);
    } else {
      console.log(`✓ Uneseno: ${doc.title} (${chunks.length} isječak/a) → ${url}`);
    }
  }

  console.log('Gotovo.');
}

main().catch((e) => { console.error(e); process.exit(1); });
