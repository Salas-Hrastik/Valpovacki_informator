/**
 * Ingestijski cjevovod s optimizacijom svježine.
 * Postojeći dokumenti učitavaju se U STRANICAMA (Supabase vraća najviše 1000
 * redaka po upitu) — inače se dokumenti preko 1000 ne bi prepoznavali i stalno
 * bi se reobrađivali.
 */
import { createHash } from 'crypto';
import { config } from '../config';
import { chunkText } from '../chunking';
import { embedTexts, l2norm } from '../embeddings';
import { supabaseAdmin } from '../supabase';
import { fetchResource, gatherUrls, isAllowedHost, isOldArchiveUrl, sleep } from './crawler';
import {
  extractFromHtml,
  extractFromImage,
  extractFromPdf,
  extractImageLinks,
  extractPdfLinks,
} from './extract';

// Prozor svježine: dokument provjeren unutar zadnjih FRESH_DAYS dana preskačemo.
// Postavljen ispod tjednog ciklusa (7 dana) kako bismo izbjegli rad samo s
// dvostrukim provjeravanjem, a istovremeno ostavili marginu za pomak rasporeda.
const FRESH_DAYS = 5;
const PAGE = 1000;

/**
 * Procjenjuje "svježinu sadržaja" iz URL-a radi prioritizacije (veće = novije).
 * Čita prvu godinu (i opcijski mjesec/dan) iz putanje — npr. /2026/06/11/… ili
 * /wp-content/uploads/2026/02/…. URL-ovi BEZ godine tretiraju se kao AKTUALNI
 * (dobivaju današnji datum) jer su to obično evergreen stranice (kontakt, usluge).
 */
function recencyScore(url: string, now: Date = new Date()): number {
  const m = url.match(/\/(19|20)(\d{2})(?:\/(\d{1,2}))?(?:\/(\d{1,2}))?/);
  if (!m) return now.getFullYear() * 372 + (now.getMonth() + 1) * 31 + now.getDate();
  const year = parseInt(m[1] + m[2], 10);
  const month = m[3] ? parseInt(m[3], 10) : 0;
  const day = m[4] ? parseInt(m[4], 10) : 0;
  return year * 372 + month * 31 + day;
}

export interface IngestStats {
  totalUrls: number;
  processed: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skippedFresh: number;
  failed: number;
  ocrUsed: number; // koliko je dokumenata obrađeno OCR-om (skenirani PDF-ovi)
  failedUrls: string[];
  durationMs: number;
}

export async function runIngest(
  opts: {
    maxUrls?: number;
    deadlineMs?: number;
    onlyUrls?: string[];
    onlyHosts?: string[];
    freshDays?: number;
  } = {},
): Promise<IngestStats> {
  const startedAt = Date.now();
  const deadline = opts.deadlineMs ? startedAt + opts.deadlineMs : Infinity;
  const maxUrls = opts.maxUrls ?? config.ingestMaxUrls;
  // Prozor svježine (dani) — nadjačiv po pokretanju: dnevni prolaz koristi kraći
  // prozor (npr. 1 dan) da bi se događanja/vijesti uistinu osvježavali svaki dan.
  const freshMs = (opts.freshDays ?? FRESH_DAYS) * 24 * 60 * 60 * 1000;
  // Ciljani način: kad su zadani onlyUrls, obrađujemo samo njih (+ PDF/slike koje
  // otkrijemo na tim stranicama) i tjeramo obradu (zaobilazimo provjeru svježine).
  const force = config.ingestForce || (opts.onlyUrls?.length ?? 0) > 0;

  const sb = supabaseAdmin();
  const stats: IngestStats = {
    totalUrls: 0, processed: 0, inserted: 0, updated: 0,
    unchanged: 0, skippedFresh: 0, failed: 0, ocrUsed: 0, failedUrls: [], durationMs: 0,
  };

  let allUrls = opts.onlyUrls ?? await gatherUrls();
  // Dnevno ažuriranje: ograniči na zadane domene (npr. valpovo.hr) — tu se
  // sadržaj najčešće dodaje. Nedjeljom (bez onlyHosts) obrađuje se sve.
  if (!opts.onlyUrls && opts.onlyHosts?.length) {
    const hosts = new Set(opts.onlyHosts.map((h) => h.toLowerCase()));
    allUrls = allUrls.filter((u) => {
      try {
        return hosts.has(new URL(u).host.toLowerCase());
      } catch {
        return false;
      }
    });
  }
  console.log(
    opts.onlyUrls
      ? `[ingest] Ciljani način: ${allUrls.length} zadanih URL-ova.`
      : opts.onlyHosts?.length
        ? `[ingest] Dnevno (domene: ${opts.onlyHosts.join(', ')}): ${allUrls.length} URL-ova.`
        : `[ingest] Pronađeno ${allUrls.length} URL-ova iz sitemapova/seedova.`,
  );

  // Učitaj SVE postojeće dokumente u stranicama po 1000 (obilazi Supabase limit)
  const existingMap = new Map<string, { hash: string; fetchedAt: string }>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('dokumenti')
      .select('url, content_hash, fetched_at')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Učitavanje postojećih dokumenata: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const d of data) {
      existingMap.set(d.url as string, { hash: d.content_hash as string, fetchedAt: d.fetched_at as string });
    }
    if (data.length < PAGE) break;
  }
  console.log(`[ingest] Učitano ${existingMap.size} postojećih dokumenata.`);

  // Poredak obrade: "najnoviji sadržaj prvi" — građane najviše zanimaju AKTUALNI
  // događaji, pa nove/recentne dokumente ingestiramo prije starijih, idući unatrag.
  //  1) dokumenti kojih JOŠ NEMA u bazi imaju prednost (novi sadržaj),
  //  2) među njima: noviji datum iz URL-a prvi (npr. /2026/06/… prije /2025/…;
  //     stranice bez datuma tretiramo kao aktualne pa su pri vrhu),
  //  3) među već postojećima: "najstarije provjereni prvi" (rotacija — da se kroz
  //     uzastopne runde svi povremeno osvježe bez zaglavljivanja na repu).
  // Tek tada režemo na maxUrls.
  const fetchedAtMs = (url: string): number => {
    const t = existingMap.get(url)?.fetchedAt;
    const ms = t ? new Date(t).getTime() : NaN;
    return Number.isFinite(ms) ? ms : 0;
  };
  const urls = allUrls
    .sort((a, b) => {
      const aNew = existingMap.has(a) ? 1 : 0;
      const bNew = existingMap.has(b) ? 1 : 0;
      if (aNew !== bNew) return aNew - bNew; // novi (0) prije postojećih (1)
      if (aNew === 0) return recencyScore(b) - recencyScore(a); // novi: najnoviji sadržaj prvi
      return fetchedAtMs(a) - fetchedAtMs(b); // postojeći: najstarije provjereni prvi (rotacija)
    })
    .slice(0, maxUrls);
  stats.totalUrls = urls.length;
  console.log(`[ingest] Za obradu (najnoviji sadržaj prvi): ${urls.length} URL-ova.`);

  // PDF-ovi i slike otkriveni praćenjem poveznica na HTML stranicama (nisu u sitemapu).
  const discoveredPdfs = new Set<string>();
  const discoveredImages = new Set<string>();
  const processedUrls = new Set<string>();

  // Je li dokument provjeren nedavno (pa ga preskačemo)? Koristi se za proračun OCR-a slika.
  const isFresh = (u: string): boolean => {
    if (force) return false;
    const p = existingMap.get(u);
    return !!(p && p.fetchedAt && Date.now() - new Date(p.fetchedAt).getTime() < freshMs);
  };

  async function processUrl(url: string): Promise<void> {
    if (processedUrls.has(url)) return;
    processedUrls.add(url);

    const prev = existingMap.get(url);
    if (
      !force &&
      prev && prev.fetchedAt &&
      Date.now() - new Date(prev.fetchedAt).getTime() < freshMs
    ) {
      stats.skippedFresh++;
      return;
    }

    try {
      const resource = await fetchResource(url);
      if (!resource) return;

      // Otkrivanje PDF i slikovnih poveznica na stranici (proračuni, odluke,
      // zapisnici, plakati s datumima manifestacija…)
      if (resource.contentType === 'html' && resource.html) {
        for (const link of extractPdfLinks(resource.html, url)) {
          if (isAllowedHost(link) && !isOldArchiveUrl(link)) discoveredPdfs.add(link);
        }
        if (config.ocrImagesEnabled) {
          for (const link of extractImageLinks(resource.html, url)) {
            if (isAllowedHost(link) && !isOldArchiveUrl(link)) discoveredImages.add(link);
          }
        }
      }

      const extracted =
        resource.contentType === 'pdf'
          ? await extractFromPdf(resource.buffer!, url)
          : resource.contentType === 'image'
            ? await extractFromImage(resource.buffer!, resource.mediaType!, url)
            : extractFromHtml(resource.html!, url);

      if (extracted.text.length < 80) return;

      const hash = createHash('sha256').update(extracted.text).digest('hex');
      const previousHash = prev?.hash;

      if (previousHash === hash) {
        await sb.rpc('touch_document', { p_url: url });
        stats.unchanged++;
        stats.processed++;
        return;
      }

      const chunks = chunkText(extracted.text);
      if (chunks.length === 0) return;
      // Naslov dokumenta uključujemo u tekst za embedding (ne i u pohranjeni isječak):
      // kratki isječci (npr. plakat s datumom) tako bolje pogađaju upit jer nose
      // kontekst naslova/događaja. Standardna RAG praksa za poboljšanje dohvata.
      const vectors = await embedTexts(chunks.map((c) => `${extracted.title}\n\n${c.text}`));

      const { error } = await sb.rpc('upsert_document_with_chunks', {
        p_doc: {
          url,
          title: extracted.title,
          source: new URL(url).hostname,
          lang: config.lang,
          municipality: 'Valpovo',
          content_text: extracted.text,
          content_hash: hash,
          published_at: extracted.publishedAt ?? '',
        },
        p_chunks: chunks.map((c, i) => ({
          chunk_index: c.chunk_index,
          text: c.text,
          tokens_est: c.tokens_est,
          embedding: vectors[i],
          norm: l2norm(vectors[i]),
        })),
      });
      if (error) throw new Error(error.message);

      if (previousHash === undefined) stats.inserted++;
      else stats.updated++;
      if (extracted.ocr) stats.ocrUsed++;
      stats.processed++;
      console.log(
        `[ingest] OK (${previousHash === undefined ? 'novo' : 'ažurirano'}${extracted.ocr ? ', OCR' : ''}): ` +
          `${url} — ${chunks.length} isječaka`,
      );
    } catch (e) {
      stats.failed++;
      stats.failedUrls.push(url);
      console.error(`[ingest] GREŠKA: ${url}`, e);
    }
    await sleep(config.crawlDelayMs);
  }

  for (const url of urls) {
    if (Date.now() > deadline) {
      console.warn('[ingest] Dosegnut vremenski limit izvršavanja — prekid (nastavlja se idući put).');
      break;
    }
    await processUrl(url);
  }

  // Drugi prolaz: PDF-ovi otkriveni na stranicama (proračuni, odluke…)
  const pdfList = [...discoveredPdfs].filter((u) => !processedUrls.has(u));
  if (pdfList.length > 0) {
    console.log(`[ingest] Otkriveno ${pdfList.length} PDF poveznica na stranicama — obrađujem.`);
  }
  for (const url of pdfList) {
    if (Date.now() > deadline) {
      console.warn('[ingest] Vremenski limit — preostali PDF-ovi idući put.');
      break;
    }
    await processUrl(url);
  }

  // Treći prolaz: slike (plakati/banneri) otkrivene na stranicama — OCR preko
  // Claude visiona. Ograničeno UKUPNIM proračunom po pokretanju (ocrImageMaxTotal);
  // svježe (nedavno provjerene) slike ne troše proračun jer se ionako preskaču.
  if (config.ocrImagesEnabled) {
    const imageList = [...discoveredImages].filter((u) => !processedUrls.has(u));
    if (imageList.length > 0) {
      console.log(
        `[ingest] Otkriveno ${imageList.length} slika za OCR — obrađujem (proračun: ${config.ocrImageMaxTotal}).`,
      );
    }
    let imageBudget = config.ocrImageMaxTotal;
    for (const url of imageList) {
      if (Date.now() > deadline) {
        console.warn('[ingest] Vremenski limit — preostale slike idući put.');
        break;
      }
      const willOcr = !isFresh(url) && !processedUrls.has(url);
      if (willOcr && imageBudget <= 0) continue; // proračun potrošen — ostavi za idući put
      await processUrl(url);
      if (willOcr) imageBudget--;
    }
  }

  stats.durationMs = Date.now() - startedAt;
  console.log(
    `[ingest] Završeno za ${Math.round(stats.durationMs / 1000)} s — ` +
      `novo: ${stats.inserted}, ažurirano: ${stats.updated}, nepromijenjeno: ${stats.unchanged}, ` +
      `preskočeno (svježe): ${stats.skippedFresh}, OCR: ${stats.ocrUsed}, neuspjelo: ${stats.failed}`,
  );
  return stats;
}
