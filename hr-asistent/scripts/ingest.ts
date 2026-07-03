/**
 * Lokalno pokretanje ingestije knjige:
 *   npm run ingest
 * (varijable okoline čitaju se iz .env.local)
 *
 * Dodatni načini:
 *   npm run ingest -- --dry-run        → samo prikaži prepoznate odjeljke knjige
 *                                        (naslovi + rasponi stranica), bez embeddinga
 *                                        i upisa u bazu — za provjeru podjele.
 *   npm run ingest -- --prune          → uz ingestiju obriši iz baze odjeljke kojih
 *                                        više nema u knjizi (promjena strukture).
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

/** Dry-run: prikaži prepoznatu strukturu knjige (odjeljci + stranice + veličine). */
async function dryRun(): Promise<void> {
  const { loadBookSections } = await import('../lib/ingest/book');
  const { estimateTokens } = await import('../lib/chunking');
  const sections = await loadBookSections();

  console.log(`\n[dry-run] Prepoznato odjeljaka: ${sections.length}\n`);
  let totalTokens = 0;
  for (const s of sections) {
    const t = estimateTokens(s.text);
    totalTokens += t;
    console.log(`  ${String(t).padStart(7)} tok  ${s.title}`);
  }
  console.log(`\n[dry-run] Ukupno ~${totalTokens} tokena teksta.`);
  console.log('[dry-run] Bez embeddinga i upisa u bazu. Ako podjela ne odgovara');
  console.log('[dry-run] strukturi knjige, prilagodite PAGES_PER_SECTION / MIN_SECTION_CHARS');
  console.log('[dry-run] ili knjigu isporučite kao Markdown s naslovima (vidi knowledge/README.md).');
}

async function main(): Promise<void> {
  if (process.argv.includes('--dry-run')) {
    await dryRun();
    return;
  }
  const { runIngest } = await import('../lib/ingest/pipeline');
  const stats = await runIngest({ prune: process.argv.includes('--prune') });
  if (stats.failedSections.length > 0) {
    console.warn('Neuspjeli odjeljci:\n' + stats.failedSections.join('\n'));
  }
  process.exit(stats.failed > 0 && stats.processed === 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Ingestija nije uspjela:', e);
  process.exit(1);
});
