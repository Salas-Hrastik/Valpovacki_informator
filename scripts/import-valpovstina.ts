/**
 * Ručna sinkronizacija aktualnih objava s valpovstina.info (sekundarni izvor).
 *   npm run import:valpovstina
 * Isto se pokreće dnevno u /api/ingest.
 */
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const envFile = resolve(process.cwd(), '.env.local');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function main(): Promise<void> {
  const { syncValpovstina } = await import('../lib/ingest/valpovstina');
  await syncValpovstina();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
