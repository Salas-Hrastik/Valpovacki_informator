/**
 * Prikupljanje URL-ova: sitemap(i) + seed URL-ovi, strogo filtrirano
 * po ALLOWED_HOSTS. Downloader poštuje robots.txt i rate-limit.
 */
import { config } from '../config';
import { CRAWLER_USER_AGENT, isAllowedByRobots } from './robots';

export interface FetchedResource {
  url: string;
  contentType: 'html' | 'pdf' | 'image';
  html?: string;
  buffer?: Buffer;
  mediaType?: string; // za slike: image/jpeg | image/png | image/gif | image/webp
}

/** Je li host URL-a na popisu dopuštenih domena? */
export function isAllowedHost(url: string, hosts: string[] = config.allowedHosts): boolean {
  try {
    return hosts.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Filtar po domeni: za domene navedene u config.hostIncludeFilters zadržavamo SAMO
 * URL-ove koji sadrže barem jedan zadani podniz (npr. dzobz.hr → "valpovo", da iz
 * županijskog Doma zdravlja uzmemo isključivo valpovačke ambulante). Ostale domene
 * nemaju ograničenje.
 */
export function passesHostInclude(
  url: string,
  filters: Record<string, string[]> = config.hostIncludeFilters,
): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const subs = filters[host];
    if (!subs || subs.length === 0) return true;
    const u = url.toLowerCase();
    return subs.some((s) => u.includes(s.toLowerCase()));
  } catch {
    return false;
  }
}

/**
 * Je li URL bezvrijedan za indeksiranje? Preskačemo WordPress arhive/feedove i
 * medijske datoteke (osim PDF-a) prema config.excludeUrlPatterns. PDF se uvijek
 * propušta jer iz njega izvlačimo tekst.
 */
export function isExcludedUrl(url: string, patterns: string[] = config.excludeUrlPatterns): boolean {
  const lower = url.toLowerCase();
  if (lower.endsWith('.pdf')) return false;
  return patterns.some((p) => {
    if (!p) return false;
    if (p.startsWith('re:')) {
      try {
        return new RegExp(p.slice(3), 'i').test(url);
      } catch {
        return false; // neispravan regex se ignorira
      }
    }
    return lower.includes(p.toLowerCase());
  });
}

/**
 * Je li URL stara arhiva (npr. plan nabave 2018, raspored odvoza 2015)? Gleda SVE
 * 4-znamenkaste godine u URL-u i uzima NAJVEĆU; ako je manja od config.archiveMinYear,
 * smatramo dokument arhivskim i preskačemo ga. URL-ovi BEZ godine se NE preskaču
 * (ne želimo ispustiti aktualne dokumente bez datuma u putanji). Koristi se za
 * OTKRIVENE PDF/slika poveznice (koje inače zaobilaze isExcludedUrl).
 */
export function isOldArchiveUrl(url: string, minYear: number = config.archiveMinYear): boolean {
  // Izuzeci (npr. "glasnik"): temeljni dokumenti koje UVIJEK ingestiramo bez obzira
  // na godinu — Službeni glasnici vrijede i kad su stariji.
  const lower = url.toLowerCase();
  if (config.archiveExemptPatterns.some((p) => p && lower.includes(p.toLowerCase()))) return false;
  const years = [...url.matchAll(/(?:19|20)\d{2}/g)].map((m) => parseInt(m[0], 10));
  if (years.length === 0) return false; // nema godine — ne preskačemo
  return Math.max(...years) < minYear;
}

export function isExcludedSitemap(
  url: string,
  patterns: string[] = config.excludeSitemapPatterns,
): boolean {
  const lower = url.toLowerCase();
  return patterns.some((p) => p && lower.includes(p.toLowerCase()));
}

export interface GatherResult {
  urls: string[];
  /** (Pod-)sitemapovi koji se NISU uspjeli dohvatiti (timeout/HTTP greška). Ako ih
   *  ima, prikupljeni korpus je NEPOTPUN — destruktivne radnje (prune) ga ne smiju
   *  koristiti jer bi izgubili legitimne stranice. */
  failedSitemaps: string[];
}

/** Dohvaća sve URL-ove iz sitemapova uz popis onih koji su zakazali. */
export async function gatherUrlsDetailed(opts: { applyExclude?: boolean } = {}): Promise<GatherResult> {
  // applyExclude=false vraća SIROVE URL-ove (bez filtra) — koristi se za analizu
  // korpusa (npm run ingest -- --analyze). U normalnoj ingestiji filtar je uključen.
  const applyExclude = opts.applyExclude !== false;
  // Uvijek primijeni filtar po domeni (npr. dzobz.hr → samo "valpovo"); exclude-uzorci
  // se primjenjuju samo u normalnoj ingestiji.
  const keep = (u: string) => (!applyExclude || !isExcludedUrl(u)) && passesHostInclude(u);
  const urls = new Set<string>();
  const failedSitemaps: string[] = [];

  for (const seed of config.seedUrls) {
    if (isAllowedHost(seed) && keep(seed)) urls.add(normalizeUrl(seed));
  }

  const queue = [...config.sitemapUrls];
  const visitedSitemaps = new Set<string>();

  while (queue.length > 0) {
    const sitemapUrl = queue.shift()!;
    if (visitedSitemaps.has(sitemapUrl) || !isAllowedHost(sitemapUrl)) continue;
    visitedSitemaps.add(sitemapUrl);

    try {
      const res = await fetch(sitemapUrl, {
        headers: { 'User-Agent': CRAWLER_USER_AGENT },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        failedSitemaps.push(`${sitemapUrl} (HTTP ${res.status})`);
        continue;
      }
      const xml = await res.text();

      // Jednostavna ekstrakcija <loc> elemenata (bez dodatne XML ovisnosti)
      const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
      const isIndex = /<sitemapindex/i.test(xml);
      for (const loc of locs) {
        if (!isAllowedHost(loc)) continue;
        if (isIndex || loc.endsWith('.xml')) {
          if (!applyExclude || !isExcludedSitemap(loc)) queue.push(loc);
        } else if (keep(loc)) {
          urls.add(normalizeUrl(loc));
        }
      }
    } catch (e) {
      failedSitemaps.push(sitemapUrl);
      console.warn(`[ingest] Sitemap nedostupan: ${sitemapUrl}`, e);
    }
  }

  return { urls: [...urls], failedSitemaps };
}

/** Dohvaća sve URL-ove iz konfiguriranih sitemapova (uklj. sitemap-indekse). */
export async function gatherUrls(opts: { applyExclude?: boolean } = {}): Promise<string[]> {
  return (await gatherUrlsDetailed(opts)).urls;
}

export interface SitemapNode {
  url: string;
  pageCount: number; // broj izravnih (ne-.xml) <loc> stranica u ovom sitemapu
  excluded: boolean; // bi li ga trenutačni EXCLUDE_SITEMAP_PATTERNS preskočili?
}

/**
 * Diagnostika: obiđi SVE (pod-)sitemapove bez filtriranja i vrati za svaki broj
 * izravnih stranica te bi li ga trenutačni uzorci preskočili. Služi za precizno
 * podešavanje EXCLUDE_SITEMAP_PATTERNS (vidi se točno ime i veličina svakog sitemapa).
 */
export async function mapSitemapTree(): Promise<SitemapNode[]> {
  const nodes: SitemapNode[] = [];
  const queue = [...config.sitemapUrls];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const sitemapUrl = queue.shift()!;
    if (visited.has(sitemapUrl) || !isAllowedHost(sitemapUrl)) continue;
    visited.add(sitemapUrl);

    try {
      const res = await fetch(sitemapUrl, {
        headers: { 'User-Agent': CRAWLER_USER_AGENT },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
      const isIndex = /<sitemapindex/i.test(xml);

      let pageCount = 0;
      for (const loc of locs) {
        if (!isAllowedHost(loc)) continue;
        if (isIndex || loc.endsWith('.xml')) queue.push(loc);
        else pageCount++;
      }
      if (!isIndex) nodes.push({ url: sitemapUrl, pageCount, excluded: isExcludedSitemap(sitemapUrl) });
    } catch (e) {
      console.warn(`[ingest] Sitemap nedostupan: ${sitemapUrl}`, e);
    }
  }
  return nodes;
}

/** Dohvaća jedan resurs (HTML ili PDF) uz robots.txt provjeru i timeout. */
export async function fetchResource(url: string): Promise<FetchedResource | null> {
  if (!isAllowedHost(url)) return null;
  if (!(await isAllowedByRobots(url))) {
    console.warn(`[ingest] robots.txt zabranjuje: ${url}`);
    return null;
  }

  const res = await fetch(url, {
    headers: {
      'User-Agent': CRAWLER_USER_AGENT,
      Accept: 'text/html,application/pdf;q=0.9,image/*;q=0.8,*/*;q=0.5',
    },
    signal: AbortSignal.timeout(30_000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')) {
    // Granica veličine: golem PDF (npr. skenirani višestranični) troši memoriju i
    // dugo se parsira. Odbij rano po Content-Length, a i nakon preuzimanja (zaglavlje
    // zna nedostajati ili lagati), da jedan PDF ne sruši/uspori cijeli ingest.
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > config.maxPdfBytes) {
      throw new Error(`PDF prevelik (${Math.round(declared / 1024 / 1024)} MB > granica)`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > config.maxPdfBytes) {
      throw new Error(`PDF prevelik (${Math.round(buffer.byteLength / 1024 / 1024)} MB > granica)`);
    }
    return { url, contentType: 'pdf', buffer };
  }
  if (contentType.includes('text/html') || contentType === '') {
    return { url, contentType: 'html', html: await res.text() };
  }
  // Slike (plakati, banneri) — dohvaćamo radi OCR-a. Claude vision podržava
  // jpeg/png/gif/webp; ostale formate (npr. svg) preskačemo.
  const mediaType = imageMediaType(contentType, url);
  if (mediaType) {
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > config.ocrImageMaxBytes) {
      throw new Error(`Slika prevelika (${Math.round(declared / 1024)} kB > granica)`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > config.ocrImageMaxBytes) {
      throw new Error(`Slika prevelika (${Math.round(buffer.byteLength / 1024)} kB > granica)`);
    }
    return { url, contentType: 'image', buffer, mediaType };
  }
  return null; // ostale vrste sadržaja preskačemo
}

/** Mapira content-type/ekstenziju u medijski tip koji Claude vision podržava (ili null). */
function imageMediaType(contentType: string, url: string): string | null {
  const ct = contentType.toLowerCase();
  const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return url.toLowerCase(); } })();
  if (ct.includes('image/jpeg') || ct.includes('image/jpg') || /\.jpe?g$/.test(path)) return 'image/jpeg';
  if (ct.includes('image/png') || /\.png$/.test(path)) return 'image/png';
  if (ct.includes('image/webp') || /\.webp$/.test(path)) return 'image/webp';
  if (ct.includes('image/gif') || /\.gif$/.test(path)) return 'image/gif';
  return null; // svg, bmp, ico, … — ne podržava se OCR
}

export function normalizeUrl(url: string): string {
  const u = new URL(url);
  u.hash = '';
  // Uklanjamo uobičajene tracking parametre
  for (const p of [...u.searchParams.keys()]) {
    if (p.startsWith('utm_') || p === 'fbclid' || p === 'gclid') u.searchParams.delete(p);
  }
  return u.toString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
