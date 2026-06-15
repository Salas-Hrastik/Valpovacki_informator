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
import { fetchResource, gatherUrls, sleep } from './crawler';
import { extractFromHtml, extractFromPdf } from './extract';

// Prozor svježine: dokument provjeren unutar zadnjih FRESH_DAYS dana preskačemo.
// Postavljen ispod tjednog ciklusa (7 dana) kako bismo izbjegli rad samo s
// dvostrukim provjeravanjem, a istovremeno ostavili marginu za pomak rasporeda.
const FRESH_DAYS = 5;
const FRESH_MS = FRESH_DAYS * 24 * 60 * 60 * 1000;
const PAGE = 1000;

export interface IngestStats {
  totalUrls: number;
  processed: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skippedFresh: number;
  failed: number;
  failedUrls: string[];
  durationMs: number;
}

export async function runIngest(opts: { maxUrls?: number; deadlineMs?: number } = {}): Promise<IngestStats> {
  const startedAt = Date.now();
  const deadline = opts.deadlineMs ? startedAt + opts.deadlineMs : Infinity;
  const maxUrls = opts.maxUrls ?? config.ingestMaxUrls;

  const sb = supabaseAdmin();
  const stats: IngestStats = {
    totalUrls: 0, processed: 0, inserted: 0, updated: 0,
    unchanged: 0, skippedFresh: 0, failed: 0, failedUrls: [], durationMs: 0,
  };

  const allUrls = await gatherUrls();
  console.log(`[ingest] Pronađeno ${allUrls.length} URL-ova iz sitemapova/seedova.`);

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

  // Rotacijska obrada: "najstarije provjereni prvi". Sortiramo po fetched_at
  // uzlazno; URL-ovi koji još nisu u bazi nemaju fetched_at pa dobivaju vrijeme 0
  // i obrađuju se prije svih. Tek tada režemo na maxUrls — tako kroz uzastopne
  // tjedne runde rotacijski obiđemo cijeli korpus bez "zaglavljivanja" na repu.
  const fetchedAtMs = (url: string): number => {
    const t = existingMap.get(url)?.fetchedAt;
    const ms = t ? new Date(t).getTime() : NaN;
    return Number.isFinite(ms) ? ms : 0;
  };
  const urls = allUrls.sort((a, b) => fetchedAtMs(a) - fetchedAtMs(b)).slice(0, maxUrls);
  stats.totalUrls = urls.length;
  console.log(`[ingest] Za obradu (najstarije provjereni prvi): ${urls.length} URL-ova.`);

  for (const url of urls) {
    if (Date.now() > deadline) {
      console.warn('[ingest] Dosegnut vremenski limit izvršavanja — prekid (nastavlja se idući put).');
      break;
    }

    const prev = existingMap.get(url);
    if (prev && prev.fetchedAt && Date.now() - new Date(prev.fetchedAt).getTime() < FRESH_MS) {
      stats.skippedFresh++;
      continue;
    }

    try {
      const resource = await fetchResource(url);
      if (!resource) continue;

      const extracted =
        resource.contentType === 'pdf'
          ? await extractFromPdf(resource.buffer!, url)
          : extractFromHtml(resource.html!, url);

      if (extracted.text.length < 80) continue;

      const hash = createHash('sha256').update(extracted.text).digest('hex');
      const previousHash = prev?.hash;

      if (previousHash === hash) {
        await sb.rpc('touch_document', { p_url: url });
        stats.unchanged++;
        stats.processed++;
        continue;
      }

      const chunks = chunkText(extracted.text);
      if (chunks.length === 0) continue;
      const vectors = await embedTexts(chunks.map((c) => c.text));

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
      stats.processed++;
      console.log(`[ingest] OK (${previousHash === undefined ? 'novo' : 'ažurirano'}): ${url} — ${chunks.length} isječaka`);
    } catch (e) {
      stats.failed++;
      stats.failedUrls.push(url);
      console.error(`[ingest] GREŠKA: ${url}`, e);
    }
    await sleep(config.crawlDelayMs);
  }

  stats.durationMs = Date.now() - startedAt;
  console.log(
    `[ingest] Završeno za ${Math.round(stats.durationMs / 1000)} s — ` +
      `novo: ${stats.inserted}, ažurirano: ${stats.updated}, nepromijenjeno: ${stats.unchanged}, ` +
      `preskočeno (svježe): ${stats.skippedFresh}, neuspjelo: ${stats.failed}`,
  );
  return stats;
}
