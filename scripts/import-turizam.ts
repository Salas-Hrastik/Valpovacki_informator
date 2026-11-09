/**
 * Ručni uvoz baze turističkog vodiča (visitlogic-mvp) u indeks informatora.
 * Isto radi i dnevni cron (/api/ingest) — ovo je za odmah ili lokalnu datoteku.
 *
 *   npm run import:turizam                                   # s config.touristSourceUrl (JSON)
 *   npm run import:turizam -- https://…/api/baza              # s drugog URL-a
 *   npm run import:turizam -- ../visitlogic-mvp/api/_database.js   # iz lokalne datoteke
 *   … --dry-run                                              # samo ispis kategorija
 *
 * Logika pretvorbe i sinkronizacije: lib/ingest/tourist.ts.
 */
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

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
  const src = args.find((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');

  const { config } = await import('../lib/config');
  const { fetchTouristDb, syncTouristDocs, touristDocsToImport } = await import('../lib/ingest/tourist');

  let db;
  let from: string;
  if (src && !/^https?:\/\//i.test(src)) {
    const mod = await import(pathToFileURL(resolve(src)).href);
    db = mod.db ?? mod.default;
    if (!db || typeof db !== 'object') throw new Error('Modul ne izvozi "db".');
    from = src;
  } else {
    from = src || config.touristSourceUrl;
    if (!from) throw new Error('Nije zadan izvor (TOURIST_SOURCE_URL je prazan).');
    db = await fetchTouristDb(from);
  }

  const docs = touristDocsToImport(db);
  console.log(`[turizam] ${docs.length} kategorija iz ${from}`);
  if (dryRun) {
    for (const d of docs) {
      console.log(`  ${d.text.length.toString().padStart(6)} zn  ${config.touristImportBaseUrl}#${d.key}  ${d.title}`);
    }
    return;
  }
  await syncTouristDocs(db);
}

main().catch((e) => {
  console.error('Uvoz nije uspio:', e);
  process.exit(1);
});
