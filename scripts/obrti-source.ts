/**
 * Učitavanje službenog popisa obrta iz datoteke (.csv ili .docx) + ručne dopune
 * web-adresa iz data/obrti-web.json (ključ = matični broj obrta).
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { extname, resolve } from 'path';

export const WEB_FILE = resolve(process.cwd(), 'data/obrti-web.json');

export interface WebEntry {
  naziv: string;
  web: string | null;
  /** "turizam" | "domena" | "ručno" */
  izvor?: string;
}

export function loadWebOverrides(): Record<string, WebEntry> {
  if (!existsSync(WEB_FILE)) return {};
  return JSON.parse(readFileSync(WEB_FILE, 'utf8'));
}

export async function loadObrti(file: string) {
  const { parseObrti, parseObrtiDocx } = await import('../lib/ingest/obrti');
  const path = resolve(file);
  const parsed =
    extname(path).toLowerCase() === '.docx'
      ? parseObrtiDocx(
          execFileSync('unzip', ['-p', path, 'word/document.xml'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8'),
        )
      : parseObrti(readFileSync(path, 'utf8'));
  const web = loadWebOverrides();
  let withWeb = 0;
  for (const o of parsed.obrti) {
    const w = o.mbo ? web[o.mbo]?.web : undefined;
    if (w && !o.web) { o.web = w; withWeb++; }
  }
  return { ...parsed, withWeb };
}
