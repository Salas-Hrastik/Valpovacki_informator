/**
 * Službeni popis obrta (CSV iz Obrtnog registra / Grada Valpova) → dokumenti informatora.
 *
 * Popis se grupira po glavnoj djelatnosti: jedan dokument po djelatnosti, jedan obrt
 * po odlomku, s URL-om `${config.obrtiImportBaseUrl}#<djelatnost>`. Pokretanje:
 *   npm run import:obrti -- <datoteka.csv> [--datum DD.MM.GGGG.] [--dry-run]
 *
 * PRIVATNOST: obrt vodi fizička osoba. Stupci s osobnim podacima (vlasnik, OIB,
 * prebivalište, datum rođenja…) se NIKADA ne čitaju, a dodatak ", vl. Ime Prezime"
 * uklanja se iz naziva obrta. Uvoze se samo naziv, djelatnost, poslovna adresa,
 * status i javni kontakt.
 */
import { config } from '../config';
import { syncImportedDocs, type ImportDoc, type ImportSyncStats } from './importSync';

/** Naselja Grada Valpova (filtar po stupcu mjesta, kad postoji). */
const NASELJA = ['valpovo', 'ladimirevci', 'šag', 'sag', 'nard', 'marjančaci', 'marjancaci', 'zelčin', 'zelcin', 'ivanovci', 'harkanovci'];

/** Stupci koji se NIKAD ne čitaju (osobni podaci obrtnika). */
const FORBIDDEN_COLUMNS = ['vlasnik', 'oib', 'obrtnik', 'ime i prezime', 'prezime', 'prebivali', 'rođen', 'roden', 'jmbg', 'spol', 'državljan'];

/** Prepoznavanje stupaca po podnizu zaglavlja (mala slova), redom prioriteta. */
const COLUMN_HINTS: Record<keyof ObrtRow, string[]> = {
  naziv: ['naziv obrta', 'naziv', 'tvrtka', 'ime obrta'],
  djelatnost: ['predmet poslovanja', 'djelatnost', 'nkd', 'opis'],
  adresa: ['adresa sjedišta', 'adresa sjedista', 'sjedište', 'sjediste', 'adresa', 'ulica'],
  mjesto: ['mjesto', 'naselje', 'grad', 'općina', 'opcina', 'pošta', 'posta'],
  status: ['status', 'stanje'],
  telefon: ['telefon', 'tel', 'mobitel'],
  email: ['e-pošta', 'e-posta', 'email', 'e-mail', 'mail'],
  web: ['web', 'internet', 'url'],
};

export interface ObrtRow {
  naziv: string;
  djelatnost: string;
  adresa: string;
  mjesto: string;
  status: string;
  telefon: string;
  email: string;
  web: string;
}

/** Minimalni CSV parser: separator ; ili , (autodetekcija), navodnici, BOM, CRLF. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

/** Mapira zaglavlje na polja; zabranjeni stupci se preskaču. */
function mapColumns(header: string[]): Partial<Record<keyof ObrtRow, number>> {
  const norm = header.map((h) => h.trim().toLowerCase());
  const used = new Set<number>();
  const out: Partial<Record<keyof ObrtRow, number>> = {};
  for (const field of Object.keys(COLUMN_HINTS) as (keyof ObrtRow)[]) {
    for (const hint of COLUMN_HINTS[field]) {
      const idx = norm.findIndex(
        (h, i) => !used.has(i) && h.includes(hint) && !FORBIDDEN_COLUMNS.some((f) => h.includes(f)),
      );
      if (idx >= 0) { out[field] = idx; used.add(idx); break; }
    }
  }
  return out;
}

/** Uklanja ime vlasnika iz naziva ("…, vl. Ana Horvat", "vlasnik: …"). */
export function stripOwner(naziv: string): string {
  return naziv
    .replace(/[,;-]?\s*\b(vl\.|vlasni(k|ca)\s*:?)\s*.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isInactive(status: string): boolean {
  return /odjav|brisan|prestao|prestanak|zatvoren|mirovanj|ne obavlja|privremen/i.test(status);
}

function inValpovo(mjesto: string, adresa: string): boolean {
  const s = `${mjesto} ${adresa}`.toLowerCase();
  return NASELJA.some((n) => new RegExp(`(^|[^a-zčćžšđ])${n}([^a-zčćžšđ]|$)`).test(s));
}

/** Redovi CSV-a → obrti (samo aktivni, s područja Grada Valpova, bez osobnih podataka). */
export function parseObrti(csv: string): { obrti: ObrtRow[]; skipped: number; columns: string[] } {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error('CSV nema podataka (potrebno zaglavlje + barem jedan red).');
  const cols = mapColumns(rows[0]);
  if (cols.naziv === undefined) {
    throw new Error(`Nije pronađen stupac s nazivom obrta. Zaglavlje: ${rows[0].join(' | ')}`);
  }
  const get = (r: string[], f: keyof ObrtRow) => (cols[f] === undefined ? '' : (r[cols[f]!] ?? '').trim());
  const obrti: ObrtRow[] = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const o: ObrtRow = {
      naziv: stripOwner(get(r, 'naziv')),
      djelatnost: get(r, 'djelatnost'),
      adresa: get(r, 'adresa'),
      mjesto: get(r, 'mjesto'),
      status: get(r, 'status'),
      telefon: get(r, 'telefon'),
      email: get(r, 'email'),
      web: get(r, 'web'),
    };
    const hasPlace = cols.mjesto !== undefined || cols.adresa !== undefined;
    if (!o.naziv || isInactive(o.status) || (hasPlace && !inValpovo(o.mjesto, o.adresa))) {
      skipped++;
      continue;
    }
    obrti.push(o);
  }
  const columns = (Object.keys(cols) as (keyof ObrtRow)[]).map((f) => `${f}=«${rows[0][cols[f]!].trim()}»`);
  return { obrti, skipped, columns };
}

/** Glavna djelatnost = prva stavka popisa djelatnosti (bez NKD šifre). */
function mainActivity(djelatnost: string): string {
  const first = djelatnost.split(/[;\n]|,\s(?=[A-ZČĆŽŠĐ])/)[0] ?? '';
  const clean = first.replace(/^\s*\d+(\.\d+)*\s*[-–:]?\s*/, '').trim();
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : 'Ostale djelatnosti';
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[čć]/g, 'c').replace(/[š]/g, 's').replace(/[ž]/g, 'z').replace(/[đ]/g, 'd')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    .slice(0, 60) || 'ostalo';
}

function renderObrt(o: ObrtRow): string {
  const lines = [o.naziv];
  const adresa = [o.adresa, o.mjesto && !o.adresa.toLowerCase().includes(o.mjesto.toLowerCase()) ? o.mjesto : '']
    .filter(Boolean).join(', ');
  if (adresa) lines.push(`Adresa: ${adresa}`);
  if (o.djelatnost) lines.push(`Djelatnost: ${o.djelatnost}`);
  if (o.telefon) lines.push(`Telefon: ${o.telefon}`);
  if (o.email) lines.push(`E-pošta: ${o.email}`);
  if (o.web) lines.push(`Web: ${o.web}`);
  return lines.join('\n');
}

/** Obrti → dokumenti, jedan po glavnoj djelatnosti (male skupine idu u "Ostale djelatnosti"). */
export function buildObrtiDocs(obrti: ObrtRow[], stanjeNaDan?: string): ImportDoc[] {
  const groups = new Map<string, ObrtRow[]>();
  for (const o of obrti) {
    const k = mainActivity(o.djelatnost);
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  // Pojedinačne djelatnosti s jednim obrtom spajamo u "Ostale djelatnosti" da ne
  // nastanu stotine sitnih dokumenata (svaki obrt ionako nosi svoju djelatnost u tekstu).
  const final = new Map<string, ObrtRow[]>();
  for (const [k, list] of groups) {
    const key = list.length >= 2 || groups.size <= 40 ? k : 'Ostale djelatnosti';
    final.set(key, [...(final.get(key) ?? []), ...list]);
  }
  const note = stanjeNaDan ? ` Stanje registra na dan ${stanjeNaDan.replace(/\.+$/, '')}.` : '';
  return [...final.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'hr'))
    .map(([djelatnost, list]) => ({
      key: slug(djelatnost),
      title: `Obrti u Valpovu — ${djelatnost}`,
      text:
        `Registrirani obrti na području Grada Valpova — ${djelatnost} (${list.length}).${note}\n\n` +
        list
          .sort((a, b) => a.naziv.localeCompare(b.naziv, 'hr'))
          .map(renderObrt)
          .join('\n\n'),
    }));
}

export async function syncObrtiDocs(
  docs: ImportDoc[],
  log: (msg: string) => void = console.log,
): Promise<ImportSyncStats> {
  return syncImportedDocs(docs, {
    base: config.obrtiImportBaseUrl,
    tag: 'obrti',
    // Popis se uvozi ručno iz službene datoteke; brana štiti od krivo izvezene/krnje datoteke.
    minForDelete: 5,
    log,
  });
}
