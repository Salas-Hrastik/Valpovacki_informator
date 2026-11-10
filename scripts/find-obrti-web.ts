/**
 * Traži web-sjedišta i javne telefone obrta s popisa → data/obrti-web.json.
 *
 *   npx tsx scripts/find-obrti-web.ts <popis.docx|.csv>
 *
 * Izvori:
 *  (1) turistički vodič (visitlogic) — podudaranje po nazivu (i kućnom broju adrese),
 *      odatle web i telefon,
 *  (2) vjerojatne domene iz trgovačkog naziva (naziv.hr, naziv.com…) — prihvaća se
 *      SAMO stranica koja spominje Valpovo (ili naselje) i naziv obrta,
 *  (3) telefon s vlastite web-stranice obrta (naslovna + stranica Kontakt).
 * Ručno upisani unosi (izvor / telefonIzvor "ručno") se ne diraju; pogrešan
 * pronalazak ispravite postavljanjem vrijednosti na null uz izvor "ručno".
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { ObrtRow } from '../lib/ingest/obrti';
import { loadObrti, loadWebOverrides, WEB_FILE, type WebEntry } from './obrti-source';

const UA = 'Mozilla/5.0 (compatible; ValpovackiInformator/1.0; +https://valpovacki-informator.vercel.app)';
const PLACE = /valpov|ladimirevc|šag|nard|marjanč|zelčin|ivanovc|harkanovc/i;

const fold = (s: string) =>
  s.toLowerCase()
    .replace(/[čć]/g, 'c').replace(/š/g, 's').replace(/ž/g, 'z').replace(/đ/g, 'd')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');

function domainCandidates(brand: string): string[] {
  const words = fold(brand).replace(/&/g, ' i ').split(/[^a-z0-9]+/).filter(Boolean);
  const joined = words.join('');
  if (joined.length < 4) return []; // "M", "OPAL"… — previše općenito
  const bases = new Set([joined, words.join('-')]);
  const out: string[] = [];
  for (const b of bases) for (const tld of ['hr', 'com', 'com.hr', 'eu']) out.push(`https://${b}.${tld}/`);
  return out;
}

async function fetchPage(url: string): Promise<{ url: string; html: string; text: string } | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!res.ok || !/html/i.test(res.headers.get('content-type') ?? '')) return null;
    const html = (await res.text()).slice(0, 400_000);
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    return { url: res.url, html, text };
  } catch {
    return null;
  }
}

function looksLikeIt(text: string, brand: string): boolean {
  const t = fold(text);
  const tokens = fold(brand).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  return PLACE.test(text) && tokens.length > 0 && tokens.every((w) => t.includes(w));
}

/** Hrvatski broj → "+385 31 651 244" / "+385 99 281 8667"; null ako nije valjan. */
export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+385')) d = d.slice(4);
  else if (d.startsWith('00385')) d = d.slice(5);
  else if (d.startsWith('0')) d = d.slice(1);
  else return null;
  d = d.replace(/^0/, '');
  if (!/^\d{8,9}$/.test(d)) return null;
  const mobile = /^9\d/.test(d);
  const area = mobile ? d.slice(0, 2) : d.startsWith('1') ? '1' : d.slice(0, 2);
  const rest = d.slice(area.length);
  const parts = rest.length === 7 ? [rest.slice(0, 3), rest.slice(3)] : [rest.slice(0, 3), rest.slice(3)];
  return `+385 ${area} ${parts.join(' ')}`.trim();
}

/** Telefoni sa stranice: prvo tel: poveznice, zatim brojevi u tekstu. */
function phonesFrom(html: string, text: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) {
    const p = normalizePhone(decodeURIComponent(m[1]));
    if (p) out.push(p);
  }
  for (const m of text.matchAll(/(?:\+385|00385|\b0)[\s()./-]*\d{1,2}[\s()./-]*\d{3}[\s./-]*\d{3,4}\b/g)) {
    const p = normalizePhone(m[0]);
    if (p) out.push(p);
  }
  return [...new Set(out)];
}

async function phoneFromSite(web: string): Promise<string | null> {
  const base = web.replace(/\/$/, '');
  for (const path of ['', '/kontakt', '/kontakt/', '/contact', '/kontakti']) {
    const page = await fetchPage(base + path);
    if (!page) continue;
    const phones = phonesFrom(page.html, page.text);
    if (phones.length) return phones[0];
  }
  return null;
}

interface TouristItem { name: string; web?: string; telefon?: string; adresa?: string }

async function touristItems(): Promise<TouristItem[]> {
  const items: TouristItem[] = [];
  try {
    const res = await fetch('https://visitlogic-mvp.vercel.app/api/baza', { signal: AbortSignal.timeout(15000) });
    const walk = (o: unknown): void => {
      if (Array.isArray(o)) return o.forEach(walk);
      if (o && typeof o === 'object') {
        const r = o as Record<string, unknown>;
        const name = (r.naziv ?? r.name) as string | undefined;
        if (name) {
          const web = (r.web ?? r.website) as string | undefined;
          items.push({
            name,
            web: web && /^https?:\/\//.test(web) ? web : undefined,
            telefon: typeof r.telefon === 'string' ? r.telefon : undefined,
            adresa: typeof r.adresa === 'string' ? r.adresa : undefined,
          });
        }
        Object.values(r).forEach(walk);
      }
    };
    walk(await res.json());
  } catch (e) {
    console.warn('[web] Turistički vodič nedostupan:', e instanceof Error ? e.message : e);
  }
  return items;
}

const houseNo = (s?: string) => s?.match(/\b(\d+)\s*[a-z]?\b/i)?.[1];

const words = (s: string) => fold(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
const GENERIC = new Set(['obrt', 'salon', 'studio', 'valpovo', 'frizerski', 'kozmeticki', 'caffe', 'bar', 'restoran', 'taxi', 'taksi', 'servis']);

/**
 * Stavka vodiča koja odgovara obrtu: sve (neopćenite) riječi trgovačkog naziva moraju
 * biti CIJELE riječi u nazivu stavke; kućni broj (ako ga oba imaju) se mora slagati.
 */
function matchTourist(o: ObrtRow, items: TouristItem[]): TouristItem | undefined {
  const bw = words(o.brand ?? o.naziv).filter((w) => !GENERIC.has(w));
  if (bw.length === 0 || bw.join('').length < 4) return undefined;
  return items.find((t) => {
    const tw = new Set(words(t.name));
    if (!bw.every((w) => tw.has(w))) return false;
    const a = houseNo(t.adresa);
    const b = houseNo(o.adresa);
    return !a || !b || a === b;
  });
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error('Uporaba: npx tsx scripts/find-obrti-web.ts <popis.docx|.csv>');
  const { obrti } = await loadObrti(file);
  const existing = loadWebOverrides();
  const tourist = await touristItems();
  const out: Record<string, WebEntry> = { ...existing };
  let webs = 0;
  let phones = 0;

  await pool(obrti.filter((o) => o.mbo), 12, async (o) => {
    const mbo = o.mbo!;
    const prev = existing[mbo];
    const entry: WebEntry = prev ? { ...prev } : { naziv: o.naziv, web: null };
    entry.naziv = o.naziv;
    const t = matchTourist(o, tourist);

    // Web
    if (prev?.izvor !== 'ručno') {
      entry.web = null;
      delete entry.izvor;
      if (t?.web) { entry.web = t.web; entry.izvor = 'turizam'; }
      else {
        for (const cand of domainCandidates(o.brand ?? o.naziv)) {
          const page = await fetchPage(cand);
          if (page && looksLikeIt(page.text, o.brand ?? o.naziv)) { entry.web = page.url.replace(/\/$/, ''); entry.izvor = 'domena'; break; }
        }
      }
    }
    // Telefon
    if (prev?.telefonIzvor !== 'ručno') {
      entry.telefon = null;
      delete entry.telefonIzvor;
      const tp = t?.telefon ? normalizePhone(t.telefon) : null;
      if (tp) { entry.telefon = tp; entry.telefonIzvor = 'turizam'; }
      else if (entry.web && entry.izvor !== 'turizam') {
        const sp = await phoneFromSite(entry.web);
        if (sp) { entry.telefon = sp; entry.telefonIzvor = 'web'; }
      }
    }
    if (entry.web) webs++;
    if (entry.telefon) phones++;
    if (entry.web || entry.telefon) console.log(`[kontakt] ${o.naziv} → ${entry.web ?? '-'} | ${entry.telefon ?? '-'}${t ? `  (vodič: ${t.name})` : ''}`);
    out[mbo] = entry;
  });

  mkdirSync(dirname(WEB_FILE), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(out).sort((a, b) => a[1].naziv.localeCompare(b[1].naziv, 'hr')));
  writeFileSync(WEB_FILE, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`[kontakt] Web: ${webs}, telefon: ${phones} (od ${obrti.length}). Zapisano: ${WEB_FILE}`);
}

main().catch((e) => {
  console.error('Traženje kontakata nije uspjelo:', e instanceof Error ? e.message : e);
  process.exit(1);
});
