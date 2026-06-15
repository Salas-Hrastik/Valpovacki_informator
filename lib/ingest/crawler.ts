/**
 * Prikupljanje URL-ova: sitemap(i) + seed URL-ovi, strogo filtrirano
 * po ALLOWED_HOSTS. Downloader poštuje robots.txt i rate-limit.
 */
import { config } from '../config';
import { CRAWLER_USER_AGENT, isAllowedByRobots } from './robots';

export interface FetchedResource {
  url: string;
  contentType: 'html' | 'pdf';
  html?: string;
  buffer?: Buffer;
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

/** Treba li preskočiti cijeli (pod-)sitemap prema config.excludeSitemapPatterns? */
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
  const keep = (u: string) => !applyExclude || !isExcludedUrl(u);
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
    headers: { 'User-Agent': CRAWLER_USER_AGENT, Accept: 'text/html,application/pdf;q=0.9,*/*;q=0.5' },
    signal: AbortSignal.timeout(30_000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')) {
    return { url, contentType: 'pdf', buffer: Buffer.from(await res.arrayBuffer()) };
  }
  if (contentType.includes('text/html') || contentType === '') {
    return { url, contentType: 'html', html: await res.text() };
  }
  return null; // ostale vrste sadržaja (slike i sl.) preskačemo
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
