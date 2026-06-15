/**
 * Lokalno pokretanje ingestije:
 *   npm run ingest
 * (varijable okoline čitaju se iz .env.local)
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Minimalno učitavanje .env.local bez dodatne ovisnosti
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

/**
 * Dry-run: samo prikupi URL-ove iz sitemapova/seedova (uz primijenjeni filtar
 * bezvrijednih URL-ova) i ispiši koliko ih je po domeni — BEZ dohvaćanja sadržaja,
 * embeddinga ili upisa u bazu. Korisno za provjeru da je korpus pao na ~1500–2500.
 *   npm run ingest -- --dry-run
 */
async function dryRun(): Promise<void> {
  const { gatherUrls } = await import('../lib/ingest/crawler');
  const urls = await gatherUrls();

  const perHost = new Map<string, number>();
  for (const u of urls) {
    let host = '(nevažeći)';
    try { host = new URL(u).hostname; } catch { /* ostavi oznaku */ }
    perHost.set(host, (perHost.get(host) ?? 0) + 1);
  }

  console.log(`\n[dry-run] Ukupno URL-ova nakon filtriranja: ${urls.length}\n`);
  for (const [host, n] of [...perHost.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  ${host}`);
  }
  console.log('\n[dry-run] Bez dohvaćanja sadržaja, embeddinga i upisa u bazu.');
}

/**
 * Analiza korpusa: dohvati SIROVE URL-ove (bez filtra) i po svakoj domeni prikaži
 * gdje je masa stranica — koliko ih filtar trenutačno makne, najčešće prve segmente
 * putanje, koliko URL-ova nosi godinu (arhive), te nekoliko uzoraka. Služi za
 * krojenje preciznih EXCLUDE_URL_PATTERNS.
 *   npm run ingest -- --analyze
 */
async function analyze(): Promise<void> {
  const { gatherUrls, isExcludedUrl } = await import('../lib/ingest/crawler');
  const raw = await gatherUrls({ applyExclude: false });

  const byHost = new Map<string, string[]>();
  for (const u of raw) {
    let host = '(nevažeći)';
    try { host = new URL(u).hostname; } catch { /* ostavi oznaku */ }
    const arr = byHost.get(host) ?? [];
    arr.push(u);
    byHost.set(host, arr);
  }

  const keptTotal = raw.filter((u) => !isExcludedUrl(u)).length;
  console.log(`\n[analyze] Sirovo URL-ova: ${raw.length} | nakon trenutačnog filtra: ${keptTotal} | makne se: ${raw.length - keptTotal}\n`);

  const hosts = [...byHost.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [host, list] of hosts) {
    const kept = list.filter((u) => !isExcludedUrl(u));
    const withYear = list.filter((u) => /\/(19|20)\d{2}(\/|$)/.test(u)).length;

    // Histogram po prvom segmentu putanje (na sirovim URL-ovima)
    const seg = new Map<string, number>();
    for (const u of list) {
      let first = '(korijen)';
      try {
        const parts = new URL(u).pathname.split('/').filter(Boolean);
        if (parts.length > 0) first = `/${parts[0]}/`;
      } catch { /* preskoči */ }
      seg.set(first, (seg.get(first) ?? 0) + 1);
    }
    const topSeg = [...seg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

    console.log(`■ ${host}  — sirovo ${list.length}, nakon filtra ${kept.length}, s godinom u putanji ${withYear}`);
    for (const [s, n] of topSeg) console.log(`      ${String(n).padStart(6)}  ${s}`);
    console.log('    uzorci:');
    for (const u of list.slice(0, 6)) console.log(`        ${u}`);
    console.log('');
  }
  console.log('[analyze] Bez dohvaćanja sadržaja, embeddinga i upisa u bazu.');
}

async function main(): Promise<void> {
  if (process.argv.includes('--analyze')) {
    await analyze();
    return;
  }
  if (process.argv.includes('--dry-run')) {
    await dryRun();
    return;
  }
  const { runIngest } = await import('../lib/ingest/pipeline');
  const stats = await runIngest();
  if (stats.failedUrls.length > 0) {
    console.warn('Neuspjeli URL-ovi:\n' + stats.failedUrls.join('\n'));
  }
  process.exit(stats.failed > 0 && stats.processed === 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Ingestija nije uspjela:', e);
  process.exit(1);
});
