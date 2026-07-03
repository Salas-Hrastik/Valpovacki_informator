/**
 * Cjevovod ingestije knjige: odjeljci → chunking → embeddingi → Supabase.
 *
 * Inkrementalno: za svaki odjeljak računa se SHA-256 sadržaja; nepromijenjeni
 * odjeljci se samo "dotaknu" (touch_document, bez ponovnog embeddinga), pa je
 * ponovno pokretanje jeftino. Upis dokumenta s isječcima i vektorima je
 * atomaran (RPC upsert_document_with_chunks).
 */
import { createHash } from 'crypto';
import { chunkText } from '../chunking';
import { config } from '../config';
import { embedTexts, l2norm } from '../embeddings';
import { supabaseAdmin } from '../supabase';
import { loadBookSections, type BookSection } from './book';

export interface IngestStats {
  sections: number;
  processed: number; // novi/izmijenjeni (embeddani)
  skipped: number;   // nepromijenjeni (samo touch)
  failed: number;
  chunks: number;
  pruned: number;    // obrisani zastarjeli odjeljci (uz prune: true)
  failedSections: string[];
}

export interface IngestOptions {
  /** Ukloni iz baze odjeljke kojih više nema u knjizi (nakon promjene strukture). */
  prune?: boolean;
  /** Meki vremenski limit (ms) — nakon isteka preostali odjeljci se preskaču. */
  deadlineMs?: number;
}

export async function runIngest(options: IngestOptions = {}): Promise<IngestStats> {
  const startedAt = Date.now();
  const sb = supabaseAdmin();
  const sections = await loadBookSections();
  console.log(`[ingest] Knjiga "${config.bookTitle}": ${sections.length} odjeljaka.`);

  // Postojeći hashovi — za preskakanje nepromijenjenih odjeljaka.
  const existingHash = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('dokumenti')
      .select('url, content_hash')
      .range(from, from + 999);
    if (error) throw new Error(`Učitavanje dokumenata: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const d of data) existingHash.set(d.url as string, d.content_hash as string);
    if (data.length < 1000) break;
  }

  const stats: IngestStats = {
    sections: sections.length,
    processed: 0,
    skipped: 0,
    failed: 0,
    chunks: 0,
    pruned: 0,
    failedSections: [],
  };

  for (const section of sections) {
    if (options.deadlineMs && Date.now() - startedAt > options.deadlineMs) {
      console.warn('[ingest] Vremenski limit — preostali odjeljci idu u sljedeće pokretanje.');
      break;
    }
    try {
      const hash = sha256(section.text);
      if (existingHash.get(section.ref) === hash) {
        await sb.rpc('touch_document', { p_url: section.ref });
        stats.skipped++;
        continue;
      }
      const n = await upsertSection(section, hash);
      stats.processed++;
      stats.chunks += n;
      console.log(`[ingest] ✔ ${section.title} (${n} isječaka)`);
    } catch (e) {
      stats.failed++;
      stats.failedSections.push(section.ref);
      console.error(`[ingest] ✘ ${section.title}:`, e instanceof Error ? e.message : e);
    }
  }

  // Prune: odjeljci kojih više nema u knjizi (promjena strukture/naslova) —
  // cascade u shemi uklanja i isječke i vektore.
  if (options.prune) {
    const current = new Set(sections.map((s) => s.ref));
    const stale = [...existingHash.keys()].filter((u) => !current.has(u));
    for (let i = 0; i < stale.length; i += 100) {
      const batch = stale.slice(i, i + 100);
      const { error } = await sb.from('dokumenti').delete().in('url', batch);
      if (error) throw new Error(`Prune: ${error.message}`);
      stats.pruned += batch.length;
    }
    if (stats.pruned > 0) console.log(`[ingest] Obrisano ${stats.pruned} zastarjelih odjeljaka.`);
  }

  console.log(
    `[ingest] Gotovo za ${Math.round((Date.now() - startedAt) / 1000)} s — ` +
      `novo/izmijenjeno: ${stats.processed}, nepromijenjeno: ${stats.skipped}, ` +
      `neuspjelo: ${stats.failed}, isječaka: ${stats.chunks}.`,
  );
  return stats;
}

async function upsertSection(section: BookSection, hash: string): Promise<number> {
  const chunks = chunkText(section.text);
  if (chunks.length === 0) return 0;

  // Naslov odjeljka ide u tekst PRVOG isječka radi boljeg semantičkog dohvata
  // (upit "analiza posla" pogađa i kad sam odlomak ne ponavlja naziv poglavlja).
  const texts = chunks.map((c, i) => (i === 0 ? `${section.title}\n\n${c.text}` : c.text));
  const embeddings = await embedTexts(texts);

  const sb = supabaseAdmin();
  const { error } = await sb.rpc('upsert_document_with_chunks', {
    p_doc: {
      url: section.ref,
      title: section.title,
      source: section.source,
      lang: config.lang,
      pages: section.pages,
      content_text: section.text,
      content_hash: hash,
    },
    p_chunks: chunks.map((c, i) => ({
      chunk_index: c.chunk_index,
      text: c.text,
      tokens_est: c.tokens_est,
      embedding: embeddings[i],
      norm: l2norm(embeddings[i]),
    })),
  });
  if (error) throw new Error(`upsert_document_with_chunks: ${error.message}`);
  return chunks.length;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
