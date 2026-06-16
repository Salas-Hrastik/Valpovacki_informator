/**
 * Revizija OCR-a — odgovara na pitanje "je li OCR obavio sav posao?".
 *
 *   npm run ocr:report              # BRZO: samo iz baze (što je OCR-om ušlo)
 *   npm run ocr:report -- --discover  # TEMELJITO: ponovno otkrije PDF/slike na
 *                                     # stranicama i prijavi PRAZNINE (kandidati
 *                                     # bez dokumenta = OCR pao/prazan/preskočen)
 *
 * Ne dira shemu baze. Treba SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (iz okoline
 * ili .env.local); --discover dodatno dohvaća stranice (sporo, kao mini-crawl).
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

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

const PAGE = 1000;
// Stored dokument uvijek ima ≥80 znakova (pipeline ne sprema kraće), pa kratke
// PDF/slika dokumente iznad toga ipak ističemo kao "sumnjivo kratke" — mogući
// djelomičan/slab OCR.
const SHORT_THRESHOLD = 200;

const isPdf = (u: string): boolean => /\.pdf(\?|#|$)/i.test(u);
const isImage = (u: string): boolean => /\.(jpe?g|png|webp|gif)(\?|#|$)/i.test(u);

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

async function main(): Promise<void> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Nedostaje SUPABASE_URL ili SUPABASE_SERVICE_ROLE_KEY (okolina ili .env.local).');
    process.exit(2);
  }
  const { supabaseAdmin } = await import('../lib/supabase');
  const sb = supabaseAdmin();

  // 1) Učitaj sve URL-ove iz baze (u stranicama po 1000)
  const storedUrls: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('dokumenti').select('url').range(from, from + PAGE - 1);
    if (error) throw new Error(`Učitavanje dokumenata: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const d of data) storedUrls.push(d.url as string);
    if (data.length < PAGE) break;
  }
  const storedSet = new Set(storedUrls);

  const pdfDocs = storedUrls.filter(isPdf);
  const imgDocs = storedUrls.filter(isImage);
  const htmlDocs = storedUrls.length - pdfDocs.length - imgDocs.length;

  // 2) Duljine teksta za OCR-kandidate (PDF + slike) — dohvat u manjim serijama
  const candidates = [...pdfDocs, ...imgDocs];
  const lenByUrl = new Map<string, number>();
  for (let i = 0; i < candidates.length; i += 50) {
    const batch = candidates.slice(i, i + 50);
    const { data, error } = await sb.from('dokumenti').select('url, content_text').in('url', batch);
    if (error) throw new Error(`Dohvat sadržaja: ${error.message}`);
    for (const d of data ?? []) lenByUrl.set(d.url as string, ((d.content_text as string) || '').length);
  }
  const lens = [...lenByUrl.values()];
  const shortOnes = [...lenByUrl.entries()].filter(([, n]) => n < SHORT_THRESHOLD).sort((a, b) => a[1] - b[1]);

  console.log('\n════════ OCR REVIZIJA (iz baze) ════════');
  console.log(`Ukupno dokumenata: ${storedUrls.length}  (HTML: ${htmlDocs}, PDF: ${pdfDocs.length}, slike: ${imgDocs.length})`);
  console.log(`OCR-kandidati (PDF+slike) u bazi: ${candidates.length}`);
  if (lens.length > 0) {
    console.log(
      `Duljina teksta — min: ${Math.min(...lens)}, medijan: ${median(lens)}, max: ${Math.max(...lens)} znakova`,
    );
  }
  console.log(`Sumnjivo kratki (< ${SHORT_THRESHOLD} znakova): ${shortOnes.length}`);
  for (const [url, n] of shortOnes.slice(0, 25)) console.log(`   ${String(n).padStart(5)}  ${url}`);
  if (shortOnes.length > 25) console.log(`   … i još ${shortOnes.length - 25}`);

  if (!process.argv.includes('--discover')) {
    console.log(
      '\nNapomena: ovo pokazuje što JE ušlo. Za PRAZNINE (PDF/slike koje su otkrivene,' +
        ' ali nisu spremljene — OCR pao/prazan/preskočen) pokreni: npm run ocr:report -- --discover',
    );
    return;
  }

  // 3) TEMELJITO: ponovno otkrij PDF/slika poveznice na stranicama i nađi praznine
  const { gatherUrls, fetchResource, isAllowedHost, isOldArchiveUrl, sleep } = await import(
    '../lib/ingest/crawler'
  );
  const { extractPdfLinks, extractImageLinks } = await import('../lib/ingest/extract');
  const { config } = await import('../lib/config');

  const pages = await gatherUrls();
  console.log(`\n[discover] Pregledavam ${pages.length} stranica za PDF/slika poveznice (sporo)…`);
  const discovered = new Set<string>();
  let i = 0;
  for (const url of pages) {
    i++;
    if (i % 100 === 0) console.log(`[discover] ${i}/${pages.length}…`);
    try {
      const r = await fetchResource(url);
      if (r?.contentType === 'html' && r.html) {
        for (const link of extractPdfLinks(r.html, url)) if (isAllowedHost(link)) discovered.add(link);
        if (config.ocrImagesEnabled) {
          for (const link of extractImageLinks(r.html, url)) if (isAllowedHost(link)) discovered.add(link);
        }
      }
    } catch {
      /* nedostupna stranica — preskoči */
    }
    await sleep(config.crawlDelayMs);
  }

  const gaps = [...discovered].filter((u) => !storedSet.has(u));
  // Razdvoji ARHIVU (stare godine — namjerno se preskaču) od AKTUALNIH praznina
  // (one koje bi ingest trebao obraditi; tu je stvarni posao/eventualni problem).
  const archiveGaps = gaps.filter((u) => isOldArchiveUrl(u));
  const currentGaps = gaps.filter((u) => !isOldArchiveUrl(u));
  const curPdf = currentGaps.filter(isPdf).length;
  const curImg = currentGaps.filter(isImage).length;

  const hostOf = (u: string): string => { try { return new URL(u).hostname; } catch { return '(nevažeći)'; } };
  const byHost = new Map<string, number>();
  for (const u of currentGaps) byHost.set(hostOf(u), (byHost.get(hostOf(u)) ?? 0) + 1);

  console.log('\n════════ PRAZNINE (otkriveno, ali NIJE u bazi) ════════');
  console.log(`Otkriveno kandidata: ${discovered.size}  |  praznina ukupno: ${gaps.length}`);
  console.log(`  • ARHIVA (≤${config.archiveMinYear - 1}, namjerno se preskače): ${archiveGaps.length}`);
  console.log(`  • AKTUALNO (za obradu): ${currentGaps.length}  (PDF: ${curPdf}, slike: ${curImg})`);
  console.log('    Uzroci aktualnih: čeka rotaciju/proračun idućih prolaza, ili OCR pao/prazan/prevelik.');

  console.log('\nAktualne praznine po hostu:');
  for (const [host, n] of [...byHost.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(5)}  ${host}`);
  }

  console.log('\nAktualne praznine (uzorak):');
  for (const u of currentGaps.slice(0, 50)) console.log(`   ${u}`);
  if (currentGaps.length > 50) console.log(`   … i još ${currentGaps.length - 50}`);
  console.log('\nSavjet: pojedinačno provjeri uzrok s  npm run ocr:check -- "<URL>"');
}

main().catch((e) => {
  console.error('[ocr-report] Greška:', e);
  process.exit(1);
});
