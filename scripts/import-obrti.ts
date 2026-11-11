/**
 * Uvoz službenog popisa obrta (CSV) u indeks informatora.
 *
 *   npm run import:obrti -- obrti.csv --dry-run                # pregled: stupci, broj obrta, dokumenti
 *   npm run import:obrti -- obrti.csv --datum 15.12.2026.      # uvoz (datum = stanje registra)
 *   npm run import:obrti -- Obrtnici_2026.docx --datum 10.11.2026.   # Word tablica popisa obrtnika
 *
 * Excel: Datoteka → Spremi kao → "CSV UTF-8". Svaki obrt dobiva poveznicu na Google
 * karte; web-sjedišta dolaze iz data/obrti-web.json (npx tsx scripts/find-obrti-web.ts).
 * Logika: lib/ingest/obrti.ts.
 */
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

function loadEnvLocal(): void {
  const file = resolve(process.cwd(), '.env.local');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvLocal();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const datumIdx = args.indexOf('--datum');
  const datum = datumIdx >= 0 ? args[datumIdx + 1] : undefined;
  const file = args.find((a, i) => !a.startsWith('--') && i !== datumIdx + 1);
  if (!file) throw new Error('Uporaba: npm run import:obrti -- <datoteka.csv> [--datum DD.MM.GGGG.] [--dry-run]');

  const { config } = await import('../lib/config');
  const { buildObrtiDocs, syncObrtiDocs } = await import('../lib/ingest/obrti');
  const { loadObrti } = await import('./obrti-source');

  const { obrti, skipped, columns, withWeb, withPhone } = await loadObrti(file);
  console.log(`[obrti] Prepoznati stupci: ${columns.join(', ')}`);
  console.log(`[obrti] ${obrti.length} aktivnih obrta s područja Grada Valpova (preskočeno: ${skipped}, s webom: ${withWeb}, s telefonom: ${withPhone}).`);
  const docs = buildObrtiDocs(obrti, datum);
  console.log(`[obrti] ${docs.length} dokumenata (po djelatnosti):`);
  for (const d of docs) {
    console.log(`  ${d.text.length.toString().padStart(6)} zn  ${config.obrtiImportBaseUrl}#${d.key}  ${d.title}`);
  }
  if (dryRun) {
    if (docs[0]) console.log(`\n--- Primjer (${docs[0].title}) ---\n${docs[0].text.slice(0, 800)}`);
    return;
  }
  await syncObrtiDocs(docs);
}

main().catch((e) => {
  console.error('Uvoz nije uspio:', e instanceof Error ? e.message : e);
  process.exit(1);
});
