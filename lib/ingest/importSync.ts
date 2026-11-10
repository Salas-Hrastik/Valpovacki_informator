/**
 * Zajednička sinkronizacija UVEZENIH dokumenata (nisu web-stranice, nego podaci iz
 * vanjske baze/datoteke): turistički vodič, popis obrta…
 *
 * Svaki dokument ima URL `${base}#<key>`. Sinkronizacija je idempotentna (hash
 * sadržaja → embedding samo za promijenjene), a dokumenti s istim `base` kojih više
 * nema u uvozu brišu se — uz sigurnosnu branu protiv praznog ili oštećenog uvoza.
 */
import { createHash } from 'crypto';
import { chunkText } from '../chunking';
import { config } from '../config';
import { embedTexts, l2norm } from '../embeddings';
import { supabaseAdmin } from '../supabase';

export interface ImportDoc {
  key: string;
  title: string;
  text: string;
}

export interface ImportSyncStats {
  categories: number;
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
}

export async function syncImportedDocs(
  docs: ImportDoc[],
  opts: {
    base: string;
    /** Oznaka u logu, npr. "turizam". */
    tag: string;
    /** Najmanji broj dokumenata ispod kojeg NE brišemo ništa. */
    minForDelete: number;
    log?: (msg: string) => void;
  },
): Promise<ImportSyncStats> {
  const { base, tag, minForDelete } = opts;
  const log = opts.log ?? console.log;
  const sb = supabaseAdmin();
  const source = new URL(base).hostname;

  const { data: existing, error: exErr } = await sb
    .from('dokumenti')
    .select('id, url, content_hash')
    .like('url', `${base}#%`);
  if (exErr) throw new Error(exErr.message);
  const prev = new Map(
    (existing ?? []).map((d: { id: string; url: string; content_hash: string }) => [d.url, d]),
  );

  const stats: ImportSyncStats = { categories: docs.length, inserted: 0, updated: 0, unchanged: 0, deleted: 0 };
  const keep = new Set<string>();
  for (const d of docs) {
    const url = `${base}#${d.key}`;
    keep.add(url);
    const hash = createHash('sha256').update(d.text).digest('hex');
    const old = prev.get(url);
    if (old?.content_hash === hash) {
      await sb.rpc('touch_document', { p_url: url });
      stats.unchanged++;
      continue;
    }
    const chunks = chunkText(d.text);
    const vectors = await embedTexts(chunks.map((c) => `${d.title}\n\n${c.text}`));
    const { error } = await sb.rpc('upsert_document_with_chunks', {
      p_doc: {
        url,
        title: d.title,
        source,
        lang: config.lang,
        municipality: 'Valpovo',
        content_text: d.text,
        content_hash: hash,
        published_at: '',
      },
      p_chunks: chunks.map((c, i) => ({
        chunk_index: c.chunk_index,
        text: c.text,
        tokens_est: c.tokens_est,
        embedding: vectors[i],
        norm: l2norm(vectors[i]),
      })),
    });
    if (error) throw new Error(`${url}: ${error.message}`);
    if (old) stats.updated++;
    else stats.inserted++;
    log(`[${tag}] ${old ? 'ažurirano' : 'novo'}: ${d.title} — ${chunks.length} isječaka`);
  }

  // Nestali dokumenti → brisanje (cascade uklanja isječke).
  const stale = [...prev.values()].filter((d) => !keep.has(d.url)).map((d) => d.id);
  if (stale.length > 0) {
    if (docs.length < minForDelete) {
      log(`[${tag}] UPOZORENJE: samo ${docs.length} dokumenata — preskačem brisanje ${stale.length} starih.`);
    } else {
      const { error } = await sb.from('dokumenti').delete().in('id', stale);
      if (error) throw new Error(`Brisanje: ${error.message}`);
      stats.deleted = stale.length;
    }
  }

  log(
    `[${tag}] Gotovo — novo: ${stats.inserted}, ažurirano: ${stats.updated}, ` +
      `nepromijenjeno: ${stats.unchanged}, obrisano: ${stats.deleted}`,
  );
  return stats;
}
