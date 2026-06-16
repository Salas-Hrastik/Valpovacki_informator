/**
 * Brza provjera OCR-a nad JEDNIM PDF-om ILI SLIKOM — BEZ baze i embeddinga.
 * Testira stvarnu putanju koda (fetchResource → extractFromPdf/extractFromImage),
 * pa je idealna za provjeru da OCR pročita npr. skenirani cjenik parkinga ili
 * datum s plakata (slike) na naslovnici.
 *
 *   npx tsx scripts/ocr-check.ts "<URL-PDF-a-ili-slike>"
 *
 * Primjeri:
 *   npx tsx scripts/ocr-check.ts "https://urbanizam-valpovo.hr/.../cjenik_compressed.pdf"
 *   npx tsx scripts/ocr-check.ts "https://valpovo.hr/.../plakat-ljeto.jpg"
 *
 * Treba samo ANTHROPIC_API_KEY (iz okoline ili .env.local). Ako PDF ima
 * tekstualni sloj, OCR se NEĆE okinuti (i to je točno) — vidjet ćeš "OCR: ne".
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Minimalno učitavanje .env.local (isti obrazac kao scripts/ingest.ts)
function loadEnvLocal(): void {
  const file = resolve(process.cwd(), '.env.local');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

loadEnvLocal();

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    console.error('Uporaba: npx tsx scripts/ocr-check.ts "<URL-PDF-a-ili-slike>"');
    process.exit(2);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Nedostaje ANTHROPIC_API_KEY (postavi u okolinu ili .env.local).');
    process.exit(2);
  }

  const { fetchResource } = await import('../lib/ingest/crawler');
  const { extractFromPdf, extractFromImage } = await import('../lib/ingest/extract');

  console.log(`[ocr-check] Dohvaćam: ${url}`);
  const resource = await fetchResource(url);
  if (!resource) {
    console.error('[ocr-check] Resurs nije dohvaćen (ili je preskočen filtrom hostova/robots).');
    process.exit(1);
  }
  if ((resource.contentType !== 'pdf' && resource.contentType !== 'image') || !resource.buffer) {
    console.error(`[ocr-check] URL nije PDF ni slika (contentType=${resource.contentType}).`);
    process.exit(1);
  }

  console.log(
    `[ocr-check] Vrsta: ${resource.contentType} | veličina: ${(resource.buffer.byteLength / 1024).toFixed(0)} kB`,
  );
  const doc =
    resource.contentType === 'pdf'
      ? await extractFromPdf(resource.buffer, url)
      : await extractFromImage(resource.buffer, resource.mediaType!, url);

  console.log('\n──────────── REZULTAT ────────────');
  console.log(`Naslov:   ${doc.title}`);
  console.log(`Datum:    ${doc.publishedAt ?? '(nema)'}`);
  console.log(`OCR:      ${doc.ocr ? 'DA (tekst dobiven Claude OCR-om)' : 'ne (PDF je imao tekstualni sloj)'}`);
  console.log(`Znakova:  ${doc.text.length}`);
  console.log('──────────── TEKST (prvih 1500 znakova) ────────────\n');
  console.log(doc.text.slice(0, 1500));
  console.log(doc.text.length > 1500 ? '\n… (skraćeno) …' : '');
}

main().catch((e) => {
  console.error('[ocr-check] Greška:', e);
  process.exit(1);
});
