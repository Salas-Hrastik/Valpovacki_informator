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
  const { gatherUrls, isExcludedUrl, mapSitemapTree } = await import('../lib/ingest/crawler');

  // Stablo (pod-)sitemapova — pokazuje točna imena i veličine, te bi li ih
  // trenutačni EXCLUDE_SITEMAP_PATTERNS preskočili (✗ = preskače se).
  const tree = await mapSitemapTree();
  console.log('\n[analyze] Pod-sitemapovi (✗ = trenutačno preskočeni):');
  for (const n of [...tree].sort((a, b) => b.pageCount - a.pageCount)) {
    console.log(`   ${n.excluded ? '✗' : '✓'} ${String(n.pageCount).padStart(6)}  ${n.url}`);
  }

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

/**
 * Čišćenje (prune): briše iz baze dokumente kojih VIŠE NEMA u filtriranom korpusu
 * (stare vijesti, galerije, objave bez datuma izbačene novim filtrom itd.).
 * Cascade u shemi povlači i pripadne isječke i vektore.
 *   npm run ingest -- --prune          → samo PREGLED (ništa se ne briše)
 *   npm run ingest -- --prune --apply  → stvarno brisanje
 * Sigurnosna brana: odbija brisati ako je svježe prikupljeni korpus sumnjivo malen
 * (npr. sitemap privremeno nedostupan), da ne dođe do masovnog brisanja.
 */
async function prune(apply: boolean): Promise<void> {
  const { gatherUrlsDetailed } = await import('../lib/ingest/crawler');
  const { supabaseAdmin } = await import('../lib/supabase');
  const sb = supabaseAdmin();

  const { urls, failedSitemaps } = await gatherUrlsDetailed(); // filtrirani, željeni skup
  const corpus = new Set(urls);
  console.log(`[prune] Filtrirani korpus: ${corpus.size} URL-ova.`);

  // Sigurnosna brana 1: ako ijedan sitemap nije dohvaćen, korpus je NEPOTPUN —
  // brisanje bi uklonilo legitimne stranice. Odbij i pusti korisnika da ponovi.
  if (failedSitemaps.length > 0) {
    console.error(
      `[prune] PREKID: ${failedSitemaps.length} sitemap(ova) nije dohvaćeno, korpus je nepotpun. ` +
        'Ne brišem ništa. Pokušaj ponovno (provjeri internet/dostupnost izvora):',
    );
    for (const f of failedSitemaps) console.error(`   ✗ ${f}`);
    process.exit(1);
  }

  // Sigurnosna brana 2: apsolutni minimum (očekivani korpus je ~2000).
  const MIN_CORPUS = 1500;
  if (corpus.size < MIN_CORPUS) {
    console.error(
      `[prune] PREKID: korpus (${corpus.size}) manji je od sigurnosnog praga (${MIN_CORPUS}). ` +
        'Vjerojatno nepotpuno prikupljanje — ne brišem ništa.',
    );
    process.exit(1);
  }

  // Učitaj sve postojeće dokumente (url + id) u stranicama po 1000
  const existing: { url: string; id: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('dokumenti').select('url, id').range(from, from + 999);
    if (error) throw new Error(`Učitavanje dokumenata: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const d of data) existing.push({ url: d.url as string, id: d.id as string });
    if (data.length < 1000) break;
  }

  // PDF-ovi se otkrivaju praćenjem poveznica (nisu u sitemap-korpusu), pa ih
  // NIKAD ne brišemo na temelju "nije u korpusu" — inače bi prune uklonio
  // proračune/odluke/zapisnike koje smo namjerno ingestirali.
  const staleRows = existing.filter(
    (d) => !corpus.has(d.url) && !d.url.toLowerCase().endsWith('.pdf'),
  );
  const stale = staleRows.map((d) => d.url);
  console.log(`[prune] U bazi: ${existing.length} | zadržati: ${existing.length - stale.length} | za brisanje: ${stale.length}\n`);

  if (stale.length === 0) {
    console.log('[prune] Nema zastarjelih dokumenata — baza je već usklađena s filtrom.');
    return;
  }

  // Pregled po domeni + uzorci
  const perHost = new Map<string, number>();
  for (const u of stale) {
    let host = '(nevažeći)';
    try { host = new URL(u).hostname; } catch { /* ostavi */ }
    perHost.set(host, (perHost.get(host) ?? 0) + 1);
  }
  console.log('[prune] Za brisanje po domeni:');
  for (const [host, n] of [...perHost.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(6)}  ${host}`);
  }
  console.log('[prune] Uzorci:');
  for (const u of stale.slice(0, 10)) console.log(`     ${u}`);

  if (!apply) {
    console.log('\n[prune] PREGLED — ništa nije obrisano. Za stvarno brisanje: npm run ingest -- --prune --apply');
    return;
  }

  // Brisanje po ID-u (kratki UUID) u manjim serijama — duga lista URL-ova u .in()
  // napravi predugačak upit (Supabase vrati 400). Cascade uklanja isječke i vektore.
  const ids = staleRows.map((d) => d.id);
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const { error } = await sb.from('dokumenti').delete().in('id', batch);
    if (error) throw new Error(`Brisanje serije: ${error.message}`);
    deleted += batch.length;
    console.log(`[prune] Obrisano ${deleted}/${ids.length}…`);
  }
  console.log(`\n[prune] Gotovo — obrisano ${deleted} dokumenata (uklj. isječke i vektore).`);
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
  if (process.argv.includes('--prune')) {
    await prune(process.argv.includes('--apply'));
    return;
  }
  // Ciljani način: obradi SAMO zadane URL-ove (+ PDF/slike otkrivene na njima).
  // Brzo ubacivanje pojedinih stranica/plakata bez punog prolaza, npr.:
  //   npm run ingest -- --only "https://valpovo.hr/" "https://tz.valpovo.hr/"
  if (process.argv.includes('--only')) {
    const urls = process.argv.filter((a) => /^https?:\/\//i.test(a));
    if (urls.length === 0) {
      console.error('Uporaba: npm run ingest -- --only "<URL>" ["<URL2>" …]');
      process.exit(2);
    }
    const { runIngest } = await import('../lib/ingest/pipeline');
    const stats = await runIngest({ onlyUrls: urls });
    if (stats.failedUrls.length > 0) {
      console.warn('Neuspjeli URL-ovi:\n' + stats.failedUrls.join('\n'));
    }
    process.exit(stats.failed > 0 && stats.processed === 0 ? 1 : 0);
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
