/**
 * Traži web-sjedišta obrta s popisa i zapisuje ih u data/obrti-web.json.
 *
 *   npx tsx scripts/find-obrti-web.ts <popis.docx|.csv>
 *
 * Izvori kandidata: (1) turistički vodič (visitlogic) — podudaranje po nazivu,
 * (2) vjerojatne domene iz trgovačkog naziva (naziv.hr, naziv.com…). Domena se
 * prihvaća SAMO ako stranica spominje Valpovo (ili naselje) i naziv obrta — da se
 * ne poveže tuđa istoimena tvrtka. Ručno upisani unosi (izvor "ručno") se ne diraju;
 * pogrešan pronalazak ispravite tako da postavite "web": null i "izvor": "ručno".
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
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

async function fetchText(url: string): Promise<{ url: string; text: string } | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!res.ok || !/html/i.test(res.headers.get('content-type') ?? '')) return null;
    const html = (await res.text()).slice(0, 400_000);
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    return { url: res.url, text };
  } catch {
    return null;
  }
}

function looksLikeIt(text: string, brand: string): boolean {
  const t = fold(text);
  const tokens = fold(brand).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  return PLACE.test(text) && tokens.length > 0 && tokens.every((w) => t.includes(w));
}

async function touristWebs(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const res = await fetch('https://visitlogic-mvp.vercel.app/api/baza', { signal: AbortSignal.timeout(15000) });
    const walk = (o: unknown): void => {
      if (Array.isArray(o)) return o.forEach(walk);
      if (o && typeof o === 'object') {
        const r = o as Record<string, unknown>;
        const name = (r.naziv ?? r.name) as string | undefined;
        const web = (r.web ?? r.website) as string | undefined;
        if (name && web && /^https?:\/\//.test(web)) map.set(fold(name).replace(/[^a-z0-9]/g, ''), web);
        Object.values(r).forEach(walk);
      }
    };
    walk(await res.json());
  } catch (e) {
    console.warn('[web] Turistički vodič nedostupan:', e instanceof Error ? e.message : e);
  }
  return map;
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
  const tourist = await touristWebs();
  const out: Record<string, WebEntry> = { ...existing };
  let found = 0;

  await pool(obrti.filter((o) => o.mbo), 12, async (o) => {
    const mbo = o.mbo!;
    if (existing[mbo]?.izvor === 'ručno') return;
    const brand = o.brand ?? o.naziv;
    const key = fold(brand).replace(/[^a-z0-9]/g, '');
    let web: string | null = null;
    let izvor = '';
    for (const [name, url] of tourist) {
      if (key.length >= 4 && (name === key || name.startsWith(key) || key.startsWith(name))) { web = url; izvor = 'turizam'; break; }
    }
    if (!web) {
      for (const cand of domainCandidates(brand)) {
        const page = await fetchText(cand);
        if (page && looksLikeIt(page.text, brand)) { web = page.url.replace(/\/$/, ''); izvor = 'domena'; break; }
      }
    }
    if (web) { found++; console.log(`[web] ${o.naziv} → ${web} (${izvor})`); }
    out[mbo] = { naziv: o.naziv, web, ...(izvor ? { izvor } : {}) };
  });

  mkdirSync(dirname(WEB_FILE), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(out).sort((a, b) => a[1].naziv.localeCompare(b[1].naziv, 'hr')));
  writeFileSync(WEB_FILE, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`[web] Pronađeno web-sjedišta: ${found} od ${obrti.length}. Zapisano: ${WEB_FILE}`);
}

main().catch((e) => {
  console.error('Traženje weba nije uspjelo:', e instanceof Error ? e.message : e);
  process.exit(1);
});
