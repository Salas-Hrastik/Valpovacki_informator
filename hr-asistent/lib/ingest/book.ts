/**
 * Učitavanje i strukturiranje knjige iz mape znanja (KNOWLEDGE_DIR).
 *
 * Podržani formati:
 *   - PDF s tekstualnim slojem (.pdf) — tekst se izvlači po stranicama pa se
 *     odjeljci vežu uz raspone stranica (za citate "str. X–Y");
 *   - Markdown (.md) — odjeljci po naslovima #/##/###;
 *   - čisti tekst (.txt) — odjeljci po prepoznatim naslovima.
 *
 * NAPOMENA: skenirani PDF (bez tekstualnog sloja) treba prije ingestije
 * provući kroz OCR (npr. ocrmypdf ili Adobe Acrobat) — vidi knowledge/README.md.
 *
 * Prepoznavanje poglavlja je heuristika (numerirani naslovi "2.3 Naslov" i
 * VELIKA SLOVA); ako se u datoteci ne prepozna dovoljno naslova, primjenjuje
 * se rezervna podjela na fiksne prozore od PAGES_PER_SECTION stranica.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { extname, join, basename } from 'path';
// Izravan import implementacije zaobilazi poznati problem pdf-parse v1
// (debug grana u index.js pokušava čitati testnu datoteku).
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { normalizeText } from '../chunking';
import { config } from '../config';

export interface BookSection {
  /** Stabilna interna referenca odjeljka, npr. "knjiga://mlp/knjiga/12-analiza-posla". */
  ref: string;
  /** Naslov odjeljka; uključuje raspon stranica kad je poznat. */
  title: string;
  /** Raspon stranica u knjizi, npr. "45–61" (prazno kad nije poznato). */
  pages: string;
  /** Naziv izvorne datoteke (dijagnostika). */
  source: string;
  /** Očišćeni tekst odjeljka. */
  text: string;
}

/** Učita sve datoteke znanja i vrati odjeljke knjige spremne za indeksiranje. */
export async function loadBookSections(dir: string = config.knowledgeDir): Promise<BookSection[]> {
  const files = listKnowledgeFiles(dir);
  if (files.length === 0) {
    throw new Error(
      `U mapi "${dir}" nema datoteka knjige (.pdf/.md/.txt). ` +
        'Stavite knjigu u mapu i pokušajte ponovno (vidi knowledge/README.md).',
    );
  }

  const sections: BookSection[] = [];
  for (const file of files) {
    const ext = extname(file).toLowerCase();
    const fileSlug = slugify(basename(file, ext));
    let parts: RawSection[];
    if (ext === '.pdf') {
      parts = await sectionsFromPdf(file);
    } else if (ext === '.md') {
      parts = sectionsFromMarkdown(readFileSync(file, 'utf8'));
    } else {
      parts = sectionsFromPlainText(readFileSync(file, 'utf8'));
    }

    parts = mergeTinySections(parts);
    parts.forEach((p, i) => {
      const withPages = p.pages ? `${p.title} (str. ${p.pages})` : p.title;
      sections.push({
        ref: `knjiga://${config.bookId}/${fileSlug}/${String(i + 1).padStart(3, '0')}-${slugify(p.title)}`,
        title: withPages,
        pages: p.pages,
        source: basename(file),
        text: p.text,
      });
    });
  }
  return sections;
}

export function listKnowledgeFiles(dir: string = config.knowledgeDir): string[] {
  const abs = join(process.cwd(), dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return [];
  }
  return entries
    .filter((f) => ['.pdf', '.md', '.txt'].includes(extname(f).toLowerCase()))
    .filter((f) => f.toLowerCase() !== 'readme.md')
    .sort()
    .map((f) => join(abs, f));
}

// --- Interno -----------------------------------------------------------------

interface RawSection {
  title: string;
  pages: string; // "45–61" ili ""
  text: string;
}

/** PDF → tekst po stranicama → odjeljci s rasponima stranica. */
async function sectionsFromPdf(file: string): Promise<RawSection[]> {
  const buffer = readFileSync(file);
  if (buffer.byteLength > config.maxPdfBytes) {
    throw new Error(
      `${basename(file)}: PDF je veći od granice MAX_PDF_BYTES (${config.maxPdfBytes} B).`,
    );
  }

  // Vlastiti pagerender: tekst svake stranice odvajamo znakom \f da bismo
  // poslije znali na kojoj stranici odjeljak počinje/završava.
  const data = await withTimeout(
    pdfParse(buffer, {
      pagerender: renderPageText as never,
    }),
    config.pdfParseTimeoutMs,
    `pdf-parse timeout (${config.pdfParseTimeoutMs} ms) — ${basename(file)}`,
  );

  const pages = (data.text || '').split('\f').map((p) => normalizeText(p));
  const nonEmpty = pages.filter((p) => p.length > 0);
  if (nonEmpty.length === 0 || nonEmpty.join('').length < 200) {
    throw new Error(
      `${basename(file)}: iz PDF-a nije izvučen tekst — knjiga je vjerojatno skenirana ` +
        '(bez tekstualnog sloja). Provucite je kroz OCR (npr. ocrmypdf) pa ponovite ingestiju.',
    );
  }

  const sections = splitPagesByHeadings(pages);
  // Premalo prepoznatih naslova → rezervna podjela na prozore stranica.
  if (sections.length < 3) return splitPagesByWindows(pages);
  return sections;
}

/** pdf-parse pagerender: rekonstruira tekst stranice s prijelomima redaka. */
function renderPageText(pageData: {
  getTextContent: () => Promise<{ items: { str: string; transform: number[] }[] }>;
}): Promise<string> {
  return pageData.getTextContent().then((tc) => {
    let lastY: number | null = null;
    let out = '';
    for (const item of tc.items) {
      const y = item.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 1) out += '\n';
      else if (out && !out.endsWith('\n')) out += ' ';
      out += item.str;
      lastY = y;
    }
    return out + '\f'; // marker kraja stranice
  });
}

/**
 * Naslov odjeljka? Dvije heuristike:
 *  - numerirani naslov: "3. ANALIZA POSLA", "2.4 Metode selekcije" (kratak redak
 *    koji počinje brojčanom oznakom i velikim slovom);
 *  - redak SAMO VELIKIM SLOVIMA (≥ 2 riječi, razumna duljina).
 */
function isHeadingLine(line: string): boolean {
  const l = line.trim();
  if (l.length < 4 || l.length > 90) return false;
  if (/[.:,;]$/.test(l)) return false; // rečenice/nabrajanja nisu naslovi
  if (/^\d{1,2}(\.\d{1,2}){0,2}\.?\s+\p{Lu}/u.test(l)) return true;
  const words = l.split(/\s+/);
  if (words.length >= 2 && l === l.toLocaleUpperCase('hr') && /\p{Lu}/u.test(l) && !/\d{3,}/.test(l)) {
    return true;
  }
  return false;
}

/** Stranice → odjeljci po prepoznatim naslovima, s rasponom stranica. */
function splitPagesByHeadings(pages: string[]): RawSection[] {
  const sections: RawSection[] = [];
  let current: { title: string; startPage: number; lines: string[] } | null = null;
  let lastPage = 1;

  const flush = (endPage: number) => {
    if (!current) return;
    const text = normalizeText(current.lines.join('\n'));
    if (text) {
      sections.push({
        title: current.title,
        pages: current.startPage === endPage ? `${current.startPage}` : `${current.startPage}–${endPage}`,
        text,
      });
    }
    current = null;
  };

  pages.forEach((pageText, idx) => {
    const pageNo = idx + 1;
    if (!pageText) return;
    for (const line of pageText.split('\n')) {
      if (isHeadingLine(line)) {
        flush(lastPage);
        current = { title: cleanHeading(line), startPage: pageNo, lines: [] };
      } else if (current) {
        current.lines.push(line);
      } else {
        // Tekst prije prvog naslova (naslovnica, predgovor) — vlastiti odjeljak.
        current = { title: 'Uvodne stranice', startPage: pageNo, lines: [line] };
      }
    }
    lastPage = pageNo;
  });
  flush(lastPage);
  return sections;
}

/** Rezervna podjela: fiksni prozori od PAGES_PER_SECTION stranica. */
function splitPagesByWindows(pages: string[]): RawSection[] {
  const win = Math.max(1, config.pagesPerSection);
  const sections: RawSection[] = [];
  for (let i = 0; i < pages.length; i += win) {
    const slice = pages.slice(i, i + win);
    const text = normalizeText(slice.join('\n\n'));
    if (!text) continue;
    const from = i + 1;
    const to = Math.min(i + win, pages.length);
    sections.push({
      title: `Str. ${from}–${to}`,
      pages: `${from}–${to}`,
      text,
    });
  }
  return sections;
}

/** Markdown → odjeljci po naslovima (#, ##, ###). */
function sectionsFromMarkdown(md: string): RawSection[] {
  const lines = md.split('\n');
  const sections: RawSection[] = [];
  let title = 'Uvodne stranice';
  let buf: string[] = [];

  const flush = () => {
    const text = normalizeText(buf.join('\n'));
    if (text) sections.push({ title, pages: '', text });
    buf = [];
  };

  for (const line of lines) {
    const m = line.match(/^#{1,3}\s+(.+)$/);
    if (m) {
      flush();
      title = cleanHeading(m[1]);
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

/** Čisti tekst → odjeljci po prepoznatim naslovima (ili jedan odjeljak). */
function sectionsFromPlainText(txt: string): RawSection[] {
  const sections = splitPagesByHeadings([normalizeText(txt)]);
  return sections.map((s) => ({ ...s, pages: '' }));
}

/** Sitne odjeljke (naslov bez sadržaja) spoji s prethodnim. */
function mergeTinySections(sections: RawSection[]): RawSection[] {
  const out: RawSection[] = [];
  for (const s of sections) {
    const prev = out[out.length - 1];
    if (prev && s.text.length < config.minSectionChars) {
      prev.text += `\n\n${s.title}\n${s.text}`;
      prev.pages = joinPages(prev.pages, s.pages);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

function joinPages(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const from = a.split('–')[0];
  const to = b.split('–').pop() ?? b;
  return from === to ? from : `${from}–${to}`;
}

function cleanHeading(s: string): string {
  return s.trim().replace(/\s+/g, ' ').replace(/[#*_]+$/g, '').trim();
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[čć]/g, 'c')
      .replace(/đ/g, 'd')
      .replace(/š/g, 's')
      .replace(/ž/g, 'z')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'odjeljak'
  );
}

/** Odbacuje obećanje ako ne završi unutar zadanog vremena. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!)) as Promise<T>;
}
