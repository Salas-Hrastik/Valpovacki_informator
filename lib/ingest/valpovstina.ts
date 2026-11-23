/**
 * valpovstina.info — NESLUŽBENI regionalni portal, SEKUNDARNI izvor.
 *
 * Uvozimo samo AKTUALNE objave: iz zadnjih VALPOVSTINA_DAYS dana, koje se odnose na
 * Valpovo i njegova naselja i u tekstu navode današnji ili budući datum (najave,
 * prekidi struje, radionice, upisi…). Objave kojima su svi datumi prošli brišu se
 * pri sljedećoj sinkronizaciji. Crna kronika se preskače.
 *
 * Dokumenti zadržavaju stvarni URL objave (za navođenje izvora), source =
 * "valpovstina.info". Prednost službenih izvora osiguravaju retrieval (ograničen broj
 * isječaka, iza službenih) i pravilo u promptu.
 */
import { createHash } from 'crypto';
import { chunkText } from '../chunking';
import { config } from '../config';
import { embedTexts, l2norm } from '../embeddings';
import { supabaseAdmin } from '../supabase';
import { CRAWLER_USER_AGENT } from './robots';

export const VALPOVSTINA_HOST = 'valpovstina.info';
const API = 'https://valpovstina.info/wp-json/wp/v2/posts';
const VALPOVSTINA_DAYS = 30;
const CRNA_KRONIKA = 57;
const MAX_CHARS = 6000;
const FUTURE_DAYS = 90;

/** Objava se mora odnositi na Valpovo ili naselja Grada Valpova. */
const VALPOVO_RE = /valpov|ladimirev|\bnard|\bšag\b|\bsag\b|harkanov|ivanovc|zelčin|zelcin|marjanč|marjanc/i;

const MJESECI: Record<string, number> = {
  siječ: 1, sijec: 1, veljač: 2, veljac: 2, ožuj: 3, ozuj: 3, trav: 4, svib: 5, lip: 6,
  srp: 7, kolov: 8, ruj: 9, listop: 10, studen: 11, prosin: 12,
};

export interface ValpovstinaSyncStats {
  fetched: number;
  kept: number;
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
}

const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&[a-z]+;/g, ' ');

const htmlToText = (html: string) =>
  decode(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|li|h\d|tr|br)>|<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .trim();

const iso = (g: number, m: number, d: number) =>
  m >= 1 && m <= 12 && d >= 1 && d <= 31
    ? `${g}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    : null;

/** Svi datumi spomenuti u tekstu (ISO), godina iz teksta ili iz datuma objave. */
export function datesInText(text: string, publishedIso: string): string[] {
  const pubYear = +publishedIso.slice(0, 4);
  const pubMonth = +publishedIso.slice(5, 7);
  const year = (raw: string | undefined, m: number) =>
    raw ? +raw : m < pubMonth - 2 ? pubYear + 1 : pubYear;
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})?/g)) {
    const mj = +m[2];
    const d = iso(year(m[3], mj), mj, +m[1]);
    if (d) out.add(d);
  }
  for (const m of text.matchAll(/\b(\d{1,2})\.\s*([a-zčćšžđ]+)(?:\s+(\d{4}))?/gi)) {
    const key = Object.keys(MJESECI).find((k) => m[2].toLowerCase().startsWith(k));
    if (!key) continue;
    const d = iso(year(m[3], MJESECI[key]), MJESECI[key], +m[1]);
    if (d) out.add(d);
  }
  return [...out];
}

function todayZagreb(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zagreb' }).format(new Date());
}

function formatHr(isoDate: string): string {
  const [g, m, d] = isoDate.split('-');
  return `${+d}.${+m}.${g}.`;
}

interface Post {
  date: string;
  link: string;
  title: { rendered: string };
  content: { rendered: string };
  categories: number[];
}

async function fetchRecentPosts(): Promise<Post[]> {
  const after = new Date(Date.now() - VALPOVSTINA_DAYS * 86400000).toISOString().slice(0, 19);
  const posts: Post[] = [];
  for (let page = 1; page <= 5; page++) {
    const url =
      `${API}?per_page=100&page=${page}&after=${after}` +
      `&categories_exclude=${CRNA_KRONIKA}&_fields=date,link,title,content,categories`;
    const res = await fetch(url, {
      headers: { 'User-Agent': CRAWLER_USER_AGENT },
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 400 && page > 1) break; // nema više stranica
    if (!res.ok) throw new Error(`valpovstina.info API ${res.status}`);
    const batch = (await res.json()) as Post[];
    posts.push(...batch);
    const totalPages = +(res.headers.get('x-wp-totalpages') ?? '1');
    if (page >= totalPages) break;
  }
  return posts;
}

/** Aktualne objave o Valpovu (s današnjim ili budućim datumom). */
export async function fetchValpovstinaDocs(): Promise<
  { url: string; title: string; text: string; publishedAt: string; validUntil: string }[]
> {
  const today = todayZagreb();
  const horizon = new Date(Date.now() + FUTURE_DAYS * 86400000).toISOString().slice(0, 10);
  const posts = await fetchRecentPosts();
  const docs = [];
  for (const p of posts) {
    if (p.categories?.includes(CRNA_KRONIKA)) continue;
    const title = htmlToText(p.title?.rendered ?? '');
    const body = htmlToText(p.content?.rendered ?? '');
    if (!title || body.length < 80) continue;
    if (!VALPOVO_RE.test(`${title}\n${body}`)) continue;
    const published = p.date.slice(0, 10);
    // Datumi od danas do +FUTURE_DAYS (dalji su obično blagdani/obljetnice, ne najave).
    const future = datesInText(`${title}\n${body}`, published)
      .filter((d) => d >= today && d <= horizon)
      .sort();
    if (future.length === 0) continue;
    const validUntil = future[future.length - 1];
    const text =
      `Neslužbeni portal valpovstina.info (sekundarni izvor) — objavljeno ${formatHr(published)}.\n` +
      `${title}\n\n${body}`.slice(0, MAX_CHARS);
    docs.push({ url: p.link, title: `${title} (valpovstina.info)`, text, publishedAt: published, validUntil });
  }
  return docs;
}

/**
 * Sinkronizacija: upsert aktualnih objava, brisanje svih ostalih (istekle ili
 * više nisu u prozoru) dokumenata s izvora valpovstina.info. Ako dohvat ne uspije,
 * baca grešku prije bilo kakvog brisanja.
 */
export async function syncValpovstina(log: (m: string) => void = console.log): Promise<ValpovstinaSyncStats> {
  const docs = await fetchValpovstinaDocs();
  const sb = supabaseAdmin();
  const { data: existing, error } = await sb
    .from('dokumenti')
    .select('id, url, content_hash')
    .eq('source', VALPOVSTINA_HOST);
  if (error) throw new Error(error.message);
  const prev = new Map((existing ?? []).map((d: { id: string; url: string; content_hash: string }) => [d.url, d]));

  const stats: ValpovstinaSyncStats = {
    fetched: docs.length, kept: docs.length, inserted: 0, updated: 0, unchanged: 0, deleted: 0,
  };
  const keep = new Set<string>();
  for (const d of docs) {
    keep.add(d.url);
    const hash = createHash('sha256').update(d.text).digest('hex');
    const old = prev.get(d.url);
    if (old?.content_hash === hash) {
      await sb.rpc('touch_document', { p_url: d.url });
      stats.unchanged++;
      continue;
    }
    const chunks = chunkText(d.text);
    const vectors = await embedTexts(chunks.map((c) => `${d.title}\n\n${c.text}`));
    const { error: upErr } = await sb.rpc('upsert_document_with_chunks', {
      p_doc: {
        url: d.url,
        title: d.title,
        source: VALPOVSTINA_HOST,
        lang: config.lang,
        municipality: 'Valpovo',
        content_text: d.text,
        content_hash: hash,
        published_at: d.publishedAt,
      },
      p_chunks: chunks.map((c, i) => ({
        chunk_index: c.chunk_index,
        text: c.text,
        tokens_est: c.tokens_est,
        embedding: vectors[i],
        norm: l2norm(vectors[i]),
      })),
    });
    if (upErr) throw new Error(`${d.url}: ${upErr.message}`);
    if (old) stats.updated++;
    else stats.inserted++;
    log(`[valpovstina] ${old ? 'ažurirano' : 'novo'}: ${d.title} (vrijedi do ${formatHr(d.validUntil)})`);
  }

  const stale = [...prev.values()].filter((d) => !keep.has(d.url)).map((d) => d.id);
  if (stale.length > 0) {
    const { error: delErr } = await sb.from('dokumenti').delete().in('id', stale);
    if (delErr) throw new Error(`Brisanje: ${delErr.message}`);
    stats.deleted = stale.length;
  }
  log(
    `[valpovstina] Gotovo — aktualnih: ${stats.kept}, novo: ${stats.inserted}, ažurirano: ${stats.updated}, ` +
      `nepromijenjeno: ${stats.unchanged}, obrisano (isteklo): ${stats.deleted}`,
  );
  return stats;
}
