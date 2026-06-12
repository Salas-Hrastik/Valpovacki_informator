/**
 * Ingestijski cjevovod: prikupljanje URL-ova → dohvat → ekstrakcija →
 * detekcija promjena (content_hash) → chunking → embedding → transakcijski
 * upsert u Supabase (RPC upsert_document_with_chunks).
 *
 * Inkrementalno: dokument čiji se SHA-256 sadržaja nije promijenio NE
 * vektorizira se ponovno — samo mu se osvježi oznaka fetched_at.
 */
import { createHash } from 'crypto';
import { config } from '../config';
import { chunkText } from '../chunking';
import { embedTexts, l2norm } from '../embeddings';
import { supabaseAdmin } from '../supabase';
import { fetchResource, gatherUrls, sleep } from './crawler';
import { extractFromHtml, extractFromPdf } from './extract';

export interface IngestStats {
  totalUrls: number;
  processed: number;
  inserted: number;   // novi dokumenti
  updated: number;    // promijenjeni dokumenti (reindeksirani)
  unchanged: number;  // nepromijenjeni (preskočeni)
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
    unchanged: 0, failed: 0, failedUrls: [], durationMs: 0,
  };

  const urls = (await gatherUrls()).slice(0, maxUrls);
  stats.totalUrls = urls.length;
  console.log(`[ingest] Pronađeno ${urls.length} URL-ova za obradu.`);

  // Postojeći hashevi — za detekciju promjena bez ponovne vektorizacije
  const { data: existing } = await sb.from('dokumenti').select('url, content_hash');
  const existingHash = new Map((existing ?? []).map((d) => [d.url, d.content_hash]));

  for (const url of urls) {
    if (Date.now() > deadline) {
      console.warn('[ingest] Dosegnut vremenski limit izvršavanja — prekid (nastavlja se idući put).');
      break;
    }
    try {
      const resource = await fetchResource(url);
      if (!resource) continue;

      const extracted =
        resource.contentType === 'pdf'
          ? await extractFromPdf(resource.buffer!, url)
          : extractFromHtml(resource.html!, url);

      if (extracted.text.length < 80) continue; // prekratko = vjerojatno prazna/navigacijska stranica

      const hash = createHash('sha256').update(extracted.text).digest('hex');
      const previousHash = existingHash.get(url);

      if (previousHash === hash) {
        // Nepromijenjeno → samo osvježi datum zadnje provjere
        await sb.rpc('touch_document', { p_url: url });
        stats.unchanged++;
        stats.processed++;
        continue;
      }

      // Chunking + embedding
      const chunks = chunkText(extracted.text);
      if (chunks.length === 0) continue;
      const vectors = await embedTexts(chunks.map((c) => c.text));

      // Transakcijski upsert (dokument + isječci + ugradnje u jednoj transakciji)
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
    await sleep(config.crawlDelayMs); // pristojnost prema izvorima
  }

  stats.durationMs = Date.now() - startedAt;
  console.log(
    `[ingest] Završeno za ${Math.round(stats.durationMs / 1000)} s — ` +
      `novo: ${stats.inserted}, ažurirano: ${stats.updated}, nepromijenjeno: ${stats.unchanged}, ` +
      `neuspjelo: ${stats.failed}`,
  );
  return stats;
}
