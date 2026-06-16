/**
 * Ekstrakcija teksta iz HTML-a (Cheerio) i PDF-a (pdf-parse),
 * uz čišćenje boilerplatea i normalizaciju.
 */
import * as cheerio from 'cheerio';
// Izravan import implementacije zaobilazi poznati problem pdf-parse v1
// (debug grana u index.js pokušava čitati testnu datoteku).
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { normalizeText } from '../chunking';
import { config } from '../config';
import { ocrImage, ocrPdf } from './ocr';

export interface ExtractedDocument {
  title: string;
  text: string;
  publishedAt: string | null; // ISO ili null
  ocr?: boolean; // true ako je tekst dobiven OCR-om (skenirani PDF)
}

/** Elementi koji su gotovo uvijek boilerplate i ne nose sadržaj. */
const BOILERPLATE_SELECTORS = [
  'script', 'style', 'noscript', 'iframe', 'svg',
  'nav', 'header', 'footer', 'aside', 'form',
  '.cookie', '.cookies', '#cookie-banner', '.gdpr',
  '.menu', '.navbar', '.breadcrumb', '.breadcrumbs',
  '.sidebar', '.widget', '.share', '.social', '.pagination',
].join(',');

export function extractFromHtml(html: string, url: string): ExtractedDocument {
  const $ = cheerio.load(html);
  $(BOILERPLATE_SELECTORS).remove();

  const title =
    $('meta[property="og:title"]').attr('content')?.trim() ||
    $('title').first().text().trim() ||
    $('h1').first().text().trim() ||
    url;

  // Datum objave, ako ga stranica deklarira
  const publishedAt =
    $('meta[property="article:published_time"]').attr('content') ||
    $('time[datetime]').first().attr('datetime') ||
    null;

  // Preferiramo semantičke spremnike sadržaja; u suprotnom cijeli <body>
  const root =
    ($('main').length && $('main')) ||
    ($('article').length && $('article')) ||
    ($('#content').length && $('#content')) ||
    $('body');

  // Naslove pretvaramo u zasebne retke kako bi chunking po odlomcima
  // zadržao strukturu dokumenta.
  root.find('h1, h2, h3, h4, li, p, td, br').each((_, el) => {
    $(el).append('\n');
  });

  const text = normalizeText(root.text());
  return { title, text, publishedAt: toIsoOrNull(publishedAt) };
}

export async function extractFromPdf(buffer: Buffer, url: string): Promise<ExtractedDocument> {
  // pdf-parse je sinkrono CPU-parsiranje BEZ vlastitog timeouta — pokvaren ili
  // golem PDF može vrtjeti unedogled i zaustaviti cijeli ingest. Ograničavamo ga
  // utrkom s timeoutom; ako istekne, baca se greška (URL ide u "neuspjele", run se
  // nastavlja). Napomena: timeout ne može prekinuti samo CPU-parsiranje, ali jamči
  // da se obrada dokumenta ne zaglavi i da petlja krene dalje.
  const data = await withTimeout(
    pdfParse(buffer),
    config.pdfParseTimeoutMs,
    `pdf-parse timeout (${config.pdfParseTimeoutMs} ms)`,
  );
  const title = (data.info?.Title as string | undefined)?.trim() || fileNameFromUrl(url);
  const text = normalizeText(data.text || '');
  const publishedAt = toIsoOrNull((data.info?.CreationDate as string | undefined) ?? null);

  // OCR fallback: ako pdf-parse nije izvukao tekst, dokument je vjerojatno
  // skeniran (slika stranice). Pošalji ga Claudeu na OCR — ali samo uz granice
  // broja stranica i veličine, da trošak ostane zanemariv.
  if (config.ocrEnabled && text.length < config.ocrMinTextLen) {
    const pages = (data.numpages as number | undefined) ?? 0;
    if (pages > config.ocrMaxPages) {
      console.warn(`[ocr] preskačem ${url} — ${pages} str. > granica (${config.ocrMaxPages}).`);
    } else if (buffer.byteLength > config.ocrMaxBytes) {
      console.warn(`[ocr] preskačem ${url} — ${Math.round(buffer.byteLength / 1024 / 1024)} MB > granica.`);
    } else {
      const ocrText = normalizeText(await ocrPdf(buffer, url));
      if (ocrText.length >= config.ocrMinTextLen) {
        return { title, text: ocrText, publishedAt, ocr: true };
      }
    }
  }

  return { title, text, publishedAt };
}

/**
 * OCR samostalne slike (plakat/banner). Vraća ekstrahirani dokument s tekstom
 * pročitanim s slike (ocr: true). Wrapano u timeout radi sigurnosti.
 */
export async function extractFromImage(
  buffer: Buffer,
  mediaType: string,
  url: string,
): Promise<ExtractedDocument> {
  const text = normalizeText(
    await withTimeout(
      ocrImage(buffer, mediaType, url),
      config.pdfParseTimeoutMs,
      `ocr-image timeout (${config.pdfParseTimeoutMs} ms)`,
    ),
  );
  return { title: fileNameFromUrl(url), text, publishedAt: null, ocr: true };
}

/** Odbacuje obećanje ako ne završi unutar zadanog vremena. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Pronalazi poveznice na PDF dokumente unutar HTML stranice (npr. proračuni,
 * odluke, zapisnici linkani iz /wp-content/uploads/). Vraća apsolutne URL-ove.
 * Crawler ih ne vidi iz sitemapa, pa ih otkrivamo praćenjem poveznica.
 */
export function extractPdfLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const out = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      const abs = new URL(href, baseUrl);
      if (/\.pdf$/i.test(abs.pathname)) {
        abs.hash = '';
        out.add(abs.toString());
      }
    } catch {
      /* nevažeći href — preskoči */
    }
  });
  return [...out];
}

// Nazivi koji gotovo uvijek označavaju ukrasne slike (logotipi, ikone, pozadine) —
// njih NE šaljemo na OCR jer nemaju koristan tekst i samo troše proračun.
const IMAGE_SKIP_KEYWORDS = [
  'logo', 'icon', 'favicon', 'sprite', 'avatar', 'placeholder', 'spinner',
  'loader', 'loading', 'blank', 'pixel', 'background', 'arrow', 'flag',
  'separator', 'divider', 'button', 'badge', 'watermark', 'thumb',
];

/**
 * Pronalazi SAMOSTALNE slike (plakate/bannere) unutar HTML stranice koje su
 * kandidati za OCR (npr. plakat s datumom Ljeta valpovačkog). Vraća apsolutne
 * URL-ove. Strogo filtrirano: samo jpeg/png/webp/gif, bez logotipa/ikona, uz
 * granicu dimenzija (kad su atributi prisutni) i najviše N po stranici.
 */
export function extractImageLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const out = new Set<string>();
  const minDim = config.ocrImageMinDimension;

  $('img').each((_, el) => {
    if (out.size >= config.ocrImageMaxPerPage) return;
    const $el = $(el);
    const raw =
      $el.attr('src') || $el.attr('data-src') || $el.attr('data-lazy-src') || $el.attr('data-original');
    if (!raw || raw.startsWith('data:')) return;

    let abs: URL;
    try {
      abs = new URL(raw, baseUrl);
    } catch {
      return;
    }
    const path = abs.pathname.toLowerCase();
    if (!/\.(jpe?g|png|webp|gif)$/.test(path)) return;
    if (IMAGE_SKIP_KEYWORDS.some((k) => path.includes(k))) return;

    // Filtar dimenzija: ako su width/height atributi navedeni i sitni su, preskoči
    // (logotipi/ikone). Ako atributa nema, oslanjamo se na filtar naziva + granicu po stranici.
    const w = parseInt($el.attr('width') || '', 10);
    const h = parseInt($el.attr('height') || '', 10);
    if (Number.isFinite(w) && w > 0 && w < minDim && (!Number.isFinite(h) || h < minDim)) return;
    if (Number.isFinite(h) && h > 0 && h < minDim && (!Number.isFinite(w) || w < minDim)) return;

    abs.hash = '';
    out.add(abs.toString());
  });
  return [...out];
}

function fileNameFromUrl(url: string): string {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return decodeURIComponent(segments[segments.length - 1] || url);
  } catch {
    return url;
  }
}

function toIsoOrNull(value: string | null): string | null {
  if (!value) return null;
  // PDF datumi dolaze u obliku "D:20240115120000+01'00'"
  const pdfMatch = value.match(/^D:(\d{4})(\d{2})(\d{2})/);
  const candidate = pdfMatch ? `${pdfMatch[1]}-${pdfMatch[2]}-${pdfMatch[3]}` : value;
  const d = new Date(candidate);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
