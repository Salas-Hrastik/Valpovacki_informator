/**
 * Jednostavna offline evaluacija retrievala:
 *   npm run eval
 *
 * Skup testnih upita s referentnim odjeljcima nalazi se u scripts/eval-set.json.
 * Metrike:
 *  - hit@k       : udio upita kod kojih se referentni odjeljak pojavio među top-K izvora
 *  - preciznost  : udio citiranih izvora koji pripadaju referentnim odjeljcima
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

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

interface EvalCase {
  question: string;
  /** Dijelovi referentne oznake odjeljka ILI naslova poglavlja (podniz, bez
   *  dijakritika, malim slovima), npr. "analiza-posla" ili "motivacij". */
  expected_refs: string[];
}

/**
 * Tolerantno podudaranje: referentni unos u eval-setu je PODNIZ interne oznake
 * odjeljka (knjiga://…) ili naslova poglavlja. Smatra se pogotkom ako citirani
 * izvor (ref ili naslov) sadrži referentni niz. Oznake izoštrite stvarnim
 * vrijednostima nakon prve ingestije (npm run ingest -- --dry-run).
 */
function refMatches(source: { url: string; title: string }, expected: string): boolean {
  const e = norm(expected);
  return norm(source.url).includes(e) || norm(source.title).includes(e);
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[čć]/g, 'c')
    .replace(/đ/g, 'd')
    .replace(/š/g, 's')
    .replace(/ž/g, 'z');
}

async function main(): Promise<void> {
  const { retrieve, uniqueSources } = await import('../lib/retrieval');

  const setPath = resolve(process.cwd(), 'scripts/eval-set.json');
  const cases: EvalCase[] = JSON.parse(readFileSync(setPath, 'utf8'));

  let hits = 0;
  let citedTotal = 0;
  let citedRelevant = 0;

  for (const c of cases) {
    const chunks = await retrieve(c.question);
    const sources = uniqueSources(chunks);

    const hit = c.expected_refs.some((e) => sources.some((s) => refMatches(s, e)));
    if (hit) hits++;
    citedTotal += sources.length;
    citedRelevant += sources.filter((s) => c.expected_refs.some((e) => refMatches(s, e))).length;

    console.log(`${hit ? '✔' : '✘'} ${c.question}`);
    if (!hit) {
      console.log(
        `   očekivano: ${c.expected_refs.join(', ')}\n   dobiveno:  ${sources.map((s) => s.title).join(' | ') || '(ništa)'}`,
      );
    }
  }

  console.log('\n--- Rezultati ---');
  console.log(`hit@k:      ${(100 * hits / cases.length).toFixed(1)} % (${hits}/${cases.length})`);
  console.log(`preciznost: ${citedTotal ? (100 * citedRelevant / citedTotal).toFixed(1) : '0'} % (${citedRelevant}/${citedTotal} citata)`);
}

main().catch((e) => {
  console.error('Evaluacija nije uspjela:', e);
  process.exit(1);
});
