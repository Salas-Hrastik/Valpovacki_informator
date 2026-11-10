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
type CsvField = Exclude<keyof ObrtRow, 'mbo' | 'brand' | 'kategorija' | 'karta'>;
const COLUMN_HINTS: Record<CsvField, string[]> = {
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
  /** Matični broj obrta (javni broj iz registra) — ključ za ručne dopune (web). */
  mbo?: string;
  /** Kratki/trgovački naziv (bez pravnog oblika) — za pretragu karte i weba. */
  brand?: string;
  /** Skupina za grupiranje dokumenata (kad djelatnost nije strukturirana). */
  kategorija?: string;
  /** Poveznica na Google karte. */
  karta?: string;
}

// ---------------------------------------------------------------------------
// Word popis (Obrtnici_2026.docx): tablica [rb | MBO | "NAZIV, obrt za X, vl. Ime
// Prezime, Mjesto, Adresa" | status]. Ime vlasnika se odbacuje već pri parsiranju.
// ---------------------------------------------------------------------------

const NASELJE_RE = /(?<![\p{L}])(valpovo|ladimirevci|šag|nard|marjančaci|zelčin|ivanovci|harkanovci)(?![\p{L}])/giu;

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** Redovi tablica iz word/document.xml → ćelije (čisti tekst). */
export function docxTableRows(documentXml: string): string[][] {
  const rows = documentXml.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? [];
  return rows.map((r) =>
    (r.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map((c) =>
      decodeXml((c.match(/<w:t(?: [^>]*)?>[^<]*/g) ?? []).map((t) => t.replace(/^<w:t[^>]*>/, '')).join('')).trim(),
    ),
  );
}

const titleWord = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

/** "NAZIV, obrt za X, vl. Ime Prezime, Mjesto, Adresa" → dijelovi BEZ imena vlasnika. */
export function parseOpisObrta(raw: string): { naziv: string; adresa: string; mjesto: string } {
  const s = raw.trim().replace(/\.+$/, '');
  let head: string;
  let rest: string;
  const vl = s.match(/[\s,;-]*\bvl\b\.?\s*/i);
  if (vl && vl.index !== undefined && vl.index > 0) {
    head = s.slice(0, vl.index);
    rest = s.slice(vl.index + vl[0].length);
  } else {
    // Bez oznake "vl.": segment ispred naselja koji nije opis djelatnosti smatramo imenom vlasnika.
    const segs = s.split(/,\s*/);
    const k = segs.findIndex((seg, i) => i > 0 && new RegExp(NASELJE_RE.source, 'iu').test(seg));
    if (k >= 2 && !/obrt|uslug|trgovin|servis/i.test(segs[k - 1])) {
      head = segs.slice(0, k - 1).join(', ');
      rest = segs.slice(k - 1).join(', ');
    } else {
      head = k > 0 ? segs.slice(0, k).join(', ') : s;
      rest = k > 0 ? `, ${segs.slice(k).join(', ')}` : '';
    }
  }
  let mjesto = '';
  let adresa = '';
  const m = [...rest.matchAll(new RegExp(NASELJE_RE.source, 'giu'))][0];
  if (m && m.index !== undefined) {
    const after = rest.slice(m.index + m[0].length);
    mjesto = titleWord(m[0]);
    if (/^\s*,/.test(after) || !after.trim()) {
      adresa = after.replace(/^\s*,\s*/, '').trim();
      if (!adresa) {
        // "…, Ime Prezime, Ulica 47, Valpovo" — adresa je segment ispred naselja.
        const before = rest.slice(0, m.index).replace(/[\s,]+$/, '');
        const cut = before.lastIndexOf(',');
        adresa = cut >= 0 ? before.slice(cut + 1).trim() : '';
      }
    } else {
      adresa = after.trim();
    }
  } else {
    const cut = rest.indexOf(',');
    adresa = cut >= 0 ? rest.slice(cut + 1).trim() : '';
  }
  if (mjesto === 'Šag' || mjesto === 'šag') mjesto = 'Šag';
  return { naziv: head.replace(/[\s,;–-]+$/, '').trim(), adresa: adresa.replace(/\.+$/, ''), mjesto };
}

/** Trgovački naziv: tekst u navodnicima ili dio prije pravnog oblika ("…, obrt za…"). */
export function brandOf(naziv: string): string {
  const q = naziv.match(/["„“”]([^"„“”]{2,})["„“”]/);
  if (q) return q[1].trim();
  let b = naziv.split(/,\s*|\s+[-–]\s+/)[0];
  const words = b.split(/\s+/);
  const ob = words.findIndex((w) => /^obrt/i.test(w));
  if (ob > 0) {
    let end = ob;
    // izbaci pridjeve djelatnosti napisane malim slovima ("VALPOVAČKI DVORI ugostiteljski obrt")
    while (end > 1 && words[end - 1] === words[end - 1].toLowerCase()) end--;
    b = words.slice(0, end).join(' ');
  }
  return b.trim() || naziv;
}

/** Skupine djelatnosti (prvo podudaranje pobjeđuje; ključne riječi na malim slovima). */
const KATEGORIJE: [string, RegExp][] = [
  ['Ugostiteljstvo (kafići, restorani, catering)', /ugostitelj|caffe|cafe|kafi|restoran|pizz|bistro|catering|buffet|pečenjar|pivnic/],
  ['Smještaj i iznajmljivanje', /iznajmlj|smještaj|apartman|kuća za odmor|sobe/],
  ['Frizerski saloni, kozmetika i masaža', /frizer|kozmeti|uljepšav|masaž|masaz|massage|pedikur|manikur|nokt|beauty|wellness|tetov|šminka|depilac|fizioterap|physio|mobilizac/],
  ['Kućni ljubimci (šišanje i njega pasa)', /pasa\b|psa\b|ljubimac|ljubimc|groom/],
  ['Zdravlje i terapija', /terapij|zdravlj|njegu tijela|njega tijela/],
  ['Sport, rekreacija i poduka', /sport|rekreac|obrazov|poduk|poučav|poucav|coaching|fitnes|fitness|dnevnu skrb|skrb o djeci|vrtić|igraonic/],
  ['Auto-servisi i vozila', /auto(?!mat)|vulkaniz|automehan|limar|lakir|vozil|traktor|poljoprivredne strojeve|bicik|pomoć na cesti/],
  ['Prijevoz i taksi', /prijevoz|taksi|taxi|transport|dostav|selidb/],
  ['Elektro-, vodo- i plinoinstalacije, grijanje i klimatizacija', /elektroinst|elektro|vodoinst|plinoinst|instalac|grijanj|klimat|solar|fotonapon|dimnjač/],
  ['Građevinski i završni radovi', /građevin|gradevin|zidar|keram|fasad|krov|soboslik|ličil|licil|gips|izolac|parket|podopolag|roletar|tesar|bager|zemljan|iskop|ograd|završn|graditelj|gradilišt|suhe gradnje|bunar|podvodn|zgrad|stakl/],
  ['Stolarija, bravarija i obrada metala', /stolar|bravar|metal|tokar|zavariv|kovač|cnc|strojn|namještaj|namjestaj/],
  ['Informatika, dizajn, marketing i mediji', /informat|programir|softver|računal|racunal|web|dizajn|promidž|promidz|marketing|oglaš|oglas|medij|digital|fotograf|video|produkc|grafi|tisk|it usl|social|3d print/],
  ['Računovodstvo, savjetovanje i poslovne usluge', /računovod|racunovod|knjigovod|savjet|consult|edukac|poslovn|prevođ|prevod|posredov|agencij|inženjer|inzenjer|projektir|osiguranj|procjen|korisničk|odnose s javnošću/],
  ['Kreativne djelatnosti, umjetnost, glazba i zabava', /umjetn|glazb|music|kreativ|rukotvor|dekor|izvođač|izvodač|izvedben|zabav|event|portret|portrait/],
  ['Proizvodnja i prodaja hrane (pekare, mesnice, slastice)', /pekar|mesar|mesnic|slastič|slastic|kolač|kolac|torte|sladoled|hran|pčel|pcel|med\b|vino|rakij/],
  ['Cvjećarne i održavanje grobova', /cvjeć|cvjec|aranž|grobov|pogreb|kamenorez|klesar/],
  ['Poljoprivreda, vrtlarstvo i šumarstvo', /poljopriv|vrtlar|šum|sumar|uređenje okoliša|okoliš|košnj|kosnj|drv/],
  ['Čišćenje, održavanje i popravci', /čišćenj|ciscenj|clean|pranje rublja|praonic|održavanj|odrzavanj|popravak|popravk|servis|serv/],
  ['Krojači, zlatari, optičari i obrtničke usluge', /krojač|krojac|šivanj|sivanj|tekstil|postolar|zlatar|urar|optičar|opticar|ključ/],
  ['Trgovina', /trgovin|trgovač|trgovac|trade|prodaj|butik|shop|\bmarket\b/],
];

export function kategorijaOf(naziv: string): string {
  const s = naziv.toLowerCase();
  return KATEGORIJE.find(([, re]) => re.test(s))?.[0] ?? 'Ostale usluge i djelatnosti';
}

export function googleMapsUrl(brand: string, adresa: string, mjesto: string): string {
  const q = [brand, adresa, mjesto || 'Valpovo', 'Hrvatska'].filter(Boolean).join(', ');
  // Kratko i čitljivo (dijakritici ostaju), ali bez znakova koji lome URL ili Markdown poveznicu.
  const enc = q
    .replace(/[%&#?"'()<>\[\]{}|\\^`]/g, (c) => encodeURIComponent(c).replace(/[()']/g, (x) => `%${x.charCodeAt(0).toString(16).toUpperCase()}`))
    .replace(/\s+/g, '+');
  return `https://www.google.com/maps/search/?api=1&query=${enc}`;
}

/** Word popis obrtnika → obrti (bez imena vlasnika), s poveznicom na kartu. */
export function parseObrtiDocx(documentXml: string): { obrti: ObrtRow[]; skipped: number; columns: string[] } {
  const obrti: ObrtRow[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const cells of docxTableRows(documentXml)) {
    const opis = cells.find((c) => /\bvl\b\.?|obrt/i.test(c) && c.length > 15) ?? [...cells].sort((a, b) => b.length - a.length)[0];
    const mbo = cells.find((c) => /^\d{7,9}$/.test(c)) ?? '';
    const status = cells.find((c) => /^(u radu|preseljen|odjavljen|brisan|privremeno.*|mirovanje.*)$/i.test(c)) ?? '';
    if (!opis || !mbo || isInactive(status)) { skipped++; continue; }
    const { naziv, adresa, mjesto } = parseOpisObrta(opis);
    if (!naziv) { skipped++; continue; }
    const brand = brandOf(naziv);
    const dupKey = `${naziv}|${adresa}`.toLowerCase();
    if (seen.has(dupKey)) { skipped++; continue; }
    seen.add(dupKey);
    obrti.push({
      naziv,
      djelatnost: '', // djelatnost je već u službenom nazivu
      adresa,
      mjesto,
      status,
      telefon: '',
      email: '',
      web: '',
      mbo,
      brand,
      kategorija: kategorijaOf(naziv),
      karta: googleMapsUrl(brand, adresa, mjesto),
    });
  }
  return { obrti, skipped, columns: ['rb', 'mbo', 'naziv/adresa (bez vlasnika)', 'status'] };
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
function mapColumns(header: string[]): Partial<Record<CsvField, number>> {
  const norm = header.map((h) => h.trim().toLowerCase());
  const used = new Set<number>();
  const out: Partial<Record<CsvField, number>> = {};
  for (const field of Object.keys(COLUMN_HINTS) as CsvField[]) {
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
  const get = (r: string[], f: CsvField) => (cols[f] === undefined ? '' : (r[cols[f]!] ?? '').trim());
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
    o.brand = brandOf(o.naziv);
    o.karta = googleMapsUrl(o.brand, o.adresa, o.mjesto);
    obrti.push(o);
  }
  const columns = (Object.keys(cols) as CsvField[]).map((f) => `${f}=«${rows[0][cols[f]!].trim()}»`);
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
  if (o.karta) lines.push(`Karta: ${o.karta}`);
  return lines.join('\n');
}

/** Obrti → dokumenti, jedan po glavnoj djelatnosti (male skupine idu u "Ostale djelatnosti"). */
export function buildObrtiDocs(obrti: ObrtRow[], stanjeNaDan?: string): ImportDoc[] {
  const groups = new Map<string, ObrtRow[]>();
  for (const o of obrti) {
    const k = o.kategorija ?? mainActivity(o.djelatnost);
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
