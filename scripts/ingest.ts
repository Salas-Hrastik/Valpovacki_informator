/**
 * Lokalno pokretanje ingestije:
 *   npm run ingest
 * (varijable okoline čitaju se iz .env.local)
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Minimalno učitavanje .env.local bez dodatne ovisnosti
function loadEnvLocal(): void {
  const file = resolve(process.cwd(), '.env.local');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

loadEnvLocal();

async function main(): Promise<void> {
  const { runIngest } = await import('../lib/ingest/pipeline');
  const stats = await runIngest();
  if (stats.failedUrls.length > 0) {
    console.warn('Neuspjeli URL-ovi:\n' + stats.failedUrls.join('\n'));
  }
  process.exit(stats.failed > 0 && stats.processed === 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Ingestija nije uspjela:', e);
  process.exit(1);
});
