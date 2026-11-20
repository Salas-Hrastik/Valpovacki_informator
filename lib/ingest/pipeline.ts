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
import { discoverWpMediaPdfs, fetchResource, gatherUrls, isAllowedHost, isOldArchiveUrl, normalizeUrl, sleep } from './crawler';
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
// Već uvezeni PDF-ovi (uploadi) gotovo se nikad ne mijenjaju — ponovno ih
// provjeravamo najviše jednom u PDF_FRESH_DAYS dana, inače dnevni prolaz potroši
// sve vrijeme na stare PDF-ove i do NOVIH (npr. poziv na sjednicu) nikad ne dođe.
const PDF_FRESH_DAYS = 14;
const PAGE = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function isPdfUrl(url: string): boolean {
  return url.toLowerCase().split(/[?#]/)[0].endsWith('.pdf');
}

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

type Sb = ReturnType<typeof supabaseAdmin>;
interface ChunkRow { chunk_index: number; text: string; tokens_est: number; embedding: number[]; norm: number }

// Granice jedne serije pri spremanju: najviše isječaka i ukupnih znakova po pozivu
// baze. Veliki dokumenti (Službeni glasnik ~450 isječaka, izvješća s dugim tablicama)
// u jednom RPC-u premaše statement timeout; zato ih spremamo u serijama.
const STORE_BATCH = 60;
const STORE_BATCH_CHARS = 40_000;

function storeBatches(chunks: ChunkRow[]): ChunkRow[][] {
  const out: ChunkRow[][] = [];
  let cur: ChunkRow[] = [];
  let chars = 0;
  for (const c of chunks) {
    if (cur.length > 0 && (cur.length >= STORE_BATCH || chars + c.text.length > STORE_BATCH_CHARS)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(c);
    chars += c.text.length;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Sprema dokument i isječke. Mali dokument: jedan atomarni RPC (kao dosad).
 * Veliki: RPC s prvom serijom (zamjenjuje stare isječke) uz privremeni hash, zatim
 * ostale serije izravno u tablice, i tek na kraju pravi content_hash — ako se
 * spremanje prekine, idući prolaz vidi drugi hash i dokument ponovno obradi.
 */
async function storeDocument(sb: Sb, doc: Record<string, string>, chunks: ChunkRow[]): Promise<void> {
  const [first = [], ...rest] = storeBatches(chunks);
  const big = rest.length > 0;
  const { data: docId, error } = await sb.rpc('upsert_document_with_chunks', {
    // Veliki dokument: privremeni hash i BEZ otiska datoteke dok se ne spreme sve
    // serije — inače bi prekinuto spremanje idući put izgledalo kao nepromijenjeno.
    p_doc: big ? { ...doc, content_hash: `partial:${doc.content_hash}`, content_raw: '' } : doc,
    p_chunks: first,
  });
  if (error) throw new Error(error.message);
  if (!big) return;
  for (const [n, batch] of rest.entries()) {
    const { data: rows, error: e1 } = await sb
      .from('dijelovi')
      .insert(batch.map((c) => ({ document_id: docId, chunk_index: c.chunk_index, text: c.text, tokens_est: c.tokens_est })))
      .select('id, chunk_index');
    if (e1) throw new Error(`dijelovi (serija ${n + 2}): ${e1.message}`);
    const byIndex = new Map(batch.map((c) => [c.chunk_index, c]));
    const { error: e2 } = await sb.from('ugradnje').insert(
      (rows ?? []).map((r) => {
        const c = byIndex.get(r.chunk_index as number)!;
        return { chunk_id: r.id, ugradnja: JSON.stringify(c.embedding), norm: c.norm };
      }),
    );
    if (e2) throw new Error(`ugradnje (serija ${n + 2}): ${e2.message}`);
  }
  const { error: e3 } = await sb.from('dokumenti').update({ content_hash: doc.content_hash, content_raw: doc.content_raw ?? null }).eq('id', docId);
  if (e3) throw new Error(e3.message);
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
  // fileHash: otisak sirove PDF datoteke (pohranjen u stupcu content_raw) — vidi processUrl.
  const existingMap = new Map<string, { hash: string; fetchedAt: string; fileHash: string | null }>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('dokumenti')
      .select('url, content_hash, fetched_at, content_raw')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Učitavanje postojećih dokumenata: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const d of data) {
      existingMap.set(d.url as string, {
        hash: d.content_hash as string,
        fetchedAt: d.fetched_at as string,
        fileHash: (d.content_raw as string | null) ?? null,
      });
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
  // Seed-stranice (npr. popis Službenih glasnika) obrađujemo PRVE — s njih se
  // otkrivaju važne PDF poveznice (glasnici) pa ih stignemo obraditi u istom prolazu.
  const seedSet = new Set(
    config.seedUrls.map((s) => {
      try {
        return normalizeUrl(s);
      } catch {
        return s;
      }
    }),
  );
  const urls = allUrls
    .sort((a, b) => {
      const aSeed = seedSet.has(a) ? 0 : 1;
      const bSeed = seedSet.has(b) ? 0 : 1;
      if (aSeed !== bSeed) return aSeed - bSeed; // seed-stranice prve
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
    const windowMs = isPdfUrl(url) ? Math.max(freshMs, PDF_FRESH_DAYS * DAY_MS) : freshMs;
    if (
      !force &&
      prev && prev.fetchedAt &&
      Date.now() - new Date(prev.fetchedAt).getTime() < windowMs
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

      // PDF čija se datoteka nije promijenila (isti otisak bajtova) ne obrađujemo
      // ponovno: OCR skeniranog PDF-a svaki put vrati malo drugačiji tekst, pa bi se
      // inače svakih 14 dana plaćali OCR i ugradnje za isti dokument.
      const fileHash =
        resource.contentType === 'pdf'
          ? `sha256:${createHash('sha256').update(resource.buffer!).digest('hex')}`
          : null;
      if (fileHash && prev?.fileHash === fileHash && !prev.hash?.startsWith('partial:')) {
        await sb.rpc('touch_document', { p_url: url });
        stats.unchanged++;
        stats.processed++;
        return;
      }

      const extracted =
        resource.contentType === 'pdf'
          ? await extractFromPdf(resource.buffer!, url, {
              // Dugi OCR (do ~2 min) samo kad do kraja prolaza ima dovoljno vremena.
              maxOcrPages: deadline - Date.now() > 170_000 ? config.ocrMaxPagesLong : config.ocrMaxPages,
            })
          : resource.contentType === 'image'
            ? await extractFromImage(resource.buffer!, resource.mediaType!, url)
            : extractFromHtml(resource.html!, url);

      if (extracted.text.length < 80) return;

      const hash = createHash('sha256').update(extracted.text).digest('hex');
      const previousHash = prev?.hash;

      if (previousHash === hash) {
        await sb.rpc('touch_document', { p_url: url });
        // Stari PDF bez otiska: zapiši ga, da idući put preskočimo i ekstrakciju.
        if (fileHash && prev?.fileHash !== fileHash) {
          await sb.from('dokumenti').update({ content_raw: fileHash }).eq('url', url);
        }
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

      await storeDocument(
        sb,
        {
          url,
          title: extracted.title,
          source: new URL(url).hostname,
          lang: config.lang,
          municipality: 'Valpovo',
          content_text: extracted.text,
          content_hash: hash,
          published_at: extracted.publishedAt ?? '',
          ...(fileHash ? { content_raw: fileHash } : {}),
        },
        chunks.map((c, i) => ({
          chunk_index: c.chunk_index,
          text: c.text,
          tokens_est: c.tokens_est,
          embedding: vectors[i],
          norm: l2norm(vectors[i]),
        })),
      );

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

  // Nulti prolaz: NOVI PDF-ovi s WordPress sjedišta (REST API popis medija) kojih još
  // nema u bazi — obrađuju se PRVI, najnoviji naprijed. Inače ih nalazimo samo kad se
  // objava s poveznicom ponovno dohvati, a u velikom korpusu to zna potrajati tjednima.
  // Ograničeno na 30% vremena; ostatak ide idući put.
  if (!opts.onlyUrls && config.wpMediaHosts.length > 0) {
    const hostOk = (u: string) => {
      if (!opts.onlyHosts?.length) return true;
      try {
        return opts.onlyHosts.map((h) => h.toLowerCase()).includes(new URL(u).host.toLowerCase());
      } catch {
        return false;
      }
    };
    const fresh = (await discoverWpMediaPdfs())
      .filter((u) => hostOk(u) && !existingMap.has(u) && !isOldArchiveUrl(u))
      .sort((a, b) => recencyScore(b) - recencyScore(a));
    if (fresh.length > 0) console.log(`[ingest] WP media: ${fresh.length} novih PDF-ova — obrađujem prve.`);
    const mediaDeadline = deadline === Infinity ? Infinity : startedAt + (deadline - startedAt) * 0.3;
    for (const url of fresh) {
      if (Date.now() > mediaDeadline) {
        console.warn('[ingest] WP media: preostali novi PDF-ovi idući put.');
        break;
      }
      await processUrl(url);
    }
  }

  // HTML prolaz staje ranije (60% vremena) kako bi ostalo vremena za PDF-ove
  // (npr. Službeni glasnici) koji se obrađuju u drugom prolazu — inače na kratkom
  // limitu (Hobby ~60 s) HTML potroši sve vrijeme i do PDF-ova se nikad ne dođe.
  const htmlDeadline = deadline === Infinity ? Infinity : startedAt + (deadline - startedAt) * 0.6;
  for (const url of urls) {
    if (Date.now() > htmlDeadline) {
      console.warn('[ingest] HTML prolaz: rezerviram preostalo vrijeme za PDF-ove (nastavak idući put).');
      break;
    }
    await processUrl(url);
  }

  // Drugi prolaz: PDF-ovi otkriveni na stranicama (glasnici, proračuni, odluke…)
  // Novi PDF-ovi (kojih još nema u bazi) prvi, među njima najnoviji po datumu iz
  // URL-a (/uploads/2026/10/… prije /2025/…); zatim postojeći, najstarije provjereni prvi.
  const pdfList = [...discoveredPdfs]
    .filter((u) => !processedUrls.has(u))
    .sort((a, b) => {
      const aOld = existingMap.has(a) ? 1 : 0;
      const bOld = existingMap.has(b) ? 1 : 0;
      if (aOld !== bOld) return aOld - bOld;
      if (aOld === 0) return recencyScore(b) - recencyScore(a);
      return fetchedAtMs(a) - fetchedAtMs(b);
    });
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
