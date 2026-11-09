/**
 * Uvoz ručno održavane baze turističkog bota (visitlogic-mvp) u indeks informatora.
 *
 *   npm run import:turizam -- ../visitlogic-mvp/api/_database.js
 *   npm run import:turizam -- ../visitlogic-mvp/api/_database.js --dry-run
 *
 * Baza je JS modul (`export const db = {...}`) s kategorijama (usluge, smještaj,
 * gastronomija, sport…). Uvoze se samo kategorije kojih nema u službenim izvorima
 * (vidi SKIP_CATEGORIES). Za svaku kategoriju nastaje JEDAN dokument čiji je tekst
 * popis stavki (naziv, adresa, telefon, radno vrijeme, opis, web…), po jedna stavka
 * u odlomku — tako chunking drži stavke cjelovitima. Dokumenti dobivaju URL
 * `${config.touristImportBaseUrl}#<kategorija>`; uvoz je idempotentan (hash), a
 * kategorije kojih više nema u bazi brišu se. `--prune` ih ne dira.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

function loadEnvLocal(): void {
  const file = resolve(process.cwd(), '.env.local');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvLocal();

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Ključevi koji ne nose korisnu informaciju za odgovor (slike, koordinate, karte). */
const SKIP_KEYS = new Set(['maps_url', 'image_url', 'koordinate', 'id', 'slika', 'slike', 'images']);

/**
 * Kategorije koje informator već ima iz SLUŽBENIH izvora (tz.valpovo.hr, valpovo.hr,
 * ustanova.valpovo.hr) — ne uvozimo ih: ručne kopije bi istiskivale službene stranice
 * iz dohvata, a događanja u statičnoj bazi zastarijevaju. Uvozimo samo praznine
 * (lokalne usluge, kupovina, sport/rekreacija, ugostiteljstvo, apartmani).
 */
const SKIP_CATEGORIES = new Set([
  'grad', 'opcenito', 'znamenitosti', 'dogadanja', 'kirvaji', 'lokalna_kuhinja', 'okolica',
  'smjestaj.hoteli', 'smjestaj.ruralni_smjestaj', 'smjestaj.prenocista', 'smjestaj.sobe',
  'sport.klubovi',
]);

/** Lijepi nazivi kategorija; ostale se izvode iz ključa ("banke_i_posta" → "Banke i posta"). */
const LABELS: Record<string, string> = {
  grad: 'Opći podaci o gradu i Turističkoj zajednici',
  opcenito: 'Opće informacije o Valpovu',
  znamenitosti: 'Znamenitosti',
  lokalna_kuhinja: 'Lokalna kuhinja',
  gastronomija: 'Ugostiteljstvo',
  dogadanja: 'Manifestacije i događanja',
  kirvaji: 'Kirvaji',
  'smjestaj.hoteli': 'Smještaj: hoteli',
  'smjestaj.ruralni_smjestaj': 'Smještaj: ruralni smještaj',
  'smjestaj.apartmani': 'Smještaj: apartmani',
  'smjestaj.prenocista': 'Smještaj: prenoćišta',
  'smjestaj.sobe': 'Smještaj: sobe',
  'usluge.auto_servisi': 'Auto-servisi',
  'usluge.parkiralista': 'Parkirališta',
  'usluge.autobusni_prijevoz': 'Autobusni prijevoz',
  'kupovina.trgovacki_centri': 'Trgovački centri',
  'kupovina.supermarketi': 'Supermarketi',
  'kupovina.specijalizirane_trgovine': 'Specijalizirane trgovine',
  'kupovina.lokalni_i_suveniri': 'Lokalni proizvodi i suveniri',
  'sport.klubovi': 'Sportski klubovi',
  'sport.teretane': 'Teretane',
  'sport.objekti': 'Sportski objekti',
  'sport.rekreacija': 'Rekreacija',
  'priroda.biciklizam': 'Biciklizam',
  'priroda.ribolov': 'Ribolov',
  okolica: 'Izleti u okolici',
  'usluge.banke_i_posta': 'Banke i pošta',
  'usluge.zeljeznicki_prijevoz': 'Željeznički prijevoz',
  'usluge.frizeraji': 'Frizerski saloni',
  'usluge.saloni_za_uljepsavanje': 'Saloni za uljepšavanje (kozmetika)',
  'usluge.zdravstvo': 'Zdravstvo i ljekarne',
  'kupovina.opg': 'OPG-ovi (obiteljska poljoprivredna gospodarstva)',
  'kupovina.trznica': 'Tržnica',
  'priroda.setnice_i_parkovi': 'Šetnice i parkovi',
};

function label(key: string): string {
  if (LABELS[key]) return LABELS[key];
  const last = key.split('.').pop() ?? key;
  const s = last.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fieldLabel(key: string): string {
  const s = key.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Pretvara vrijednost u čitljiv tekst (redovi "Polje: vrijednost"). */
function render(value: Json, indent = ''): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v !== 'object' || v === null)) return value.join(', ');
    return value.map((v) => `${indent}- ${render(v, indent + '  ').trim()}`).join('\n');
  }
  const lines: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (SKIP_KEYS.has(k.toLowerCase())) continue;
    const r = render(v, indent + '  ');
    if (!r) continue;
    lines.push(r.includes('\n') ? `${indent}${fieldLabel(k)}:\n${r}` : `${indent}${fieldLabel(k)}: ${r}`);
  }
  return lines.join('\n');
}

/** Jedna stavka (objekt s "naziv") → odlomak s kategorijom u prvom retku. */
function renderItem(category: string, item: { [k: string]: Json }): string {
  const { naziv, ...rest } = item;
  const head = naziv ? `${category} — ${String(naziv)}` : category;
  const body = render(rest as Json);
  return body ? `${head}\n${body}` : head;
}

interface ImportDoc {
  key: string;
  title: string;
  text: string;
}

/** Kategorija → dokument. Nizovi objekata postaju odlomci po stavci. */
function buildDoc(key: string, value: Json): ImportDoc | null {
  const cat = label(key);
  let text: string;
  if (Array.isArray(value)) {
    text = value
      .map((v) => (v && typeof v === 'object' && !Array.isArray(v) ? renderItem(cat, v) : String(v)))
      .join('\n\n');
  } else if (value && typeof value === 'object') {
    // Objekt bez stavki (npr. "grad", "opcenito") — podsekcije kao odlomci.
    text = Object.entries(value)
      .filter(([k]) => !SKIP_KEYS.has(k.toLowerCase()))
      .map(([k, v]) => {
        if (Array.isArray(v) && v.some((x) => x && typeof x === 'object')) {
          return v
            .map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? renderItem(`${cat}: ${fieldLabel(k)}`, x) : String(x)))
            .join('\n\n');
        }
        const r = render(v);
        return r ? `${cat} — ${fieldLabel(k)}:\n${r}` : '';
      })
      .filter(Boolean)
      .join('\n\n');
  } else {
    text = String(value ?? '');
  }
  text = text.trim();
  if (text.length < 80) return null;
  return { key, title: `Turistički vodič Valpovo — ${cat}`, text };
}

/**
 * Najviša razina baze: objekt čije su SVE podsekcije nizovi stavki (npr. usluge,
 * smjestaj) dijeli se na dokument po podsekciji; ostalo je jedan dokument.
 */
function buildDocs(db: { [k: string]: Json }): ImportDoc[] {
  const docs: ImportDoc[] = [];
  for (const [key, value] of Object.entries(db)) {
    const isGroup =
      value && typeof value === 'object' && !Array.isArray(value) &&
      Object.values(value).every((v) => Array.isArray(v));
    if (isGroup) {
      for (const [sub, v] of Object.entries(value as { [k: string]: Json })) {
        const d = buildDoc(`${key}.${sub}`, v);
        if (d) docs.push(d);
      }
    } else {
      const d = buildDoc(key, value);
      if (d) docs.push(d);
    }
  }
  return docs;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbPath = args.find((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  if (!dbPath) {
    console.error('Uporaba: npm run import:turizam -- <put/do/_database.js> [--dry-run]');
    process.exit(2);
  }

  const mod = await import(pathToFileURL(resolve(dbPath)).href);
  const db = (mod.db ?? mod.default) as { [k: string]: Json } | undefined;
  if (!db || typeof db !== 'object') throw new Error('Modul ne izvozi "db".');

  const { config } = await import('../lib/config');
  const base = config.touristImportBaseUrl;
  const docs = buildDocs(db).filter((d) => !SKIP_CATEGORIES.has(d.key));
  console.log(`[turizam] ${docs.length} kategorija iz ${dbPath}`);

  if (dryRun) {
    for (const d of docs) console.log(`  ${d.text.length.toString().padStart(6)} zn  ${base}#${d.key}  ${d.title}`);
    const sample = docs.find((d) => d.key === 'usluge.bankomati') ?? docs[0];
    console.log(`\n--- uzorak (${sample.key}) ---\n${sample.text.slice(0, 1200)}`);
    return;
  }

  const { chunkText } = await import('../lib/chunking');
  const { embedTexts, l2norm } = await import('../lib/embeddings');
  const { supabaseAdmin } = await import('../lib/supabase');
  const sb = supabaseAdmin();
  const source = new URL(base).hostname;

  const { data: existing, error: exErr } = await sb
    .from('dokumenti')
    .select('id, url, content_hash')
    .like('url', `${base}#%`);
  if (exErr) throw new Error(exErr.message);
  const prev = new Map((existing ?? []).map((d: { id: string; url: string; content_hash: string }) => [d.url, d]));

  let inserted = 0, updated = 0, unchanged = 0;
  const keep = new Set<string>();
  for (const d of docs) {
    const url = `${base}#${d.key}`;
    keep.add(url);
    const hash = createHash('sha256').update(d.text).digest('hex');
    const old = prev.get(url);
    if (old?.content_hash === hash) {
      await sb.rpc('touch_document', { p_url: url });
      unchanged++;
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
    if (old) updated++;
    else inserted++;
    console.log(`[turizam] ${old ? 'ažurirano' : 'novo'}: ${d.title} — ${chunks.length} isječaka`);
  }

  // Kategorije koje su nestale iz baze → brisanje (cascade uklanja isječke).
  const stale = [...prev.values()].filter((d) => !keep.has(d.url)).map((d) => d.id);
  if (stale.length > 0) {
    const { error } = await sb.from('dokumenti').delete().in('id', stale);
    if (error) throw new Error(`Brisanje: ${error.message}`);
  }

  console.log(
    `[turizam] Gotovo — novo: ${inserted}, ažurirano: ${updated}, nepromijenjeno: ${unchanged}, obrisano: ${stale.length}`,
  );
}

main().catch((e) => {
  console.error('Uvoz nije uspio:', e);
  process.exit(1);
});
