/**
 * Jednostavna offline evaluacija retrievala:
 *   npm run eval
 *
 * Skup testnih upita s referentnim URL-ovima nalazi se u scripts/eval-set.json.
 * Metrike:
 *  - hit@k       : udio upita kod kojih se referentni URL pojavio među top-K izvora
 *  - preciznost  : udio citiranih izvora koji pripadaju referentnim URL-ovima
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
  expected_urls: string[];
}

/**
 * Tolerantno podudaranje: referentni unos u eval-setu može biti puni URL ILI samo
 * dio putanje (npr. "valpovo.hr/komunal"). Smatra se pogotkom ako citirani URL
 * sadrži referentni niz ili obrnuto. Tako mali pomaci u stvarnim putanjama ne
 * proizvode lažne promašaje; referentne nizove izoštrite nakon prve ingestije.
 */
function urlMatches(citedUrl: string, expected: string): boolean {
  const a = citedUrl.toLowerCase().replace(/\/+$/, '');
  const b = expected.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return a.includes(b) || b.includes(a.replace(/^https?:\/\//, ''));
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
    const urls = sources.map((s) => s.url);

    const hit = c.expected_urls.some((e) => urls.some((u) => urlMatches(u, e)));
    if (hit) hits++;
    citedTotal += urls.length;
    citedRelevant += urls.filter((u) => c.expected_urls.some((e) => urlMatches(u, e))).length;

    console.log(`${hit ? '✔' : '✘'} ${c.question}`);
    if (!hit) console.log(`   očekivano: ${c.expected_urls.join(', ')}\n   dobiveno:  ${urls.join(', ') || '(ništa)'}`);
  }

  console.log('\n--- Rezultati ---');
  console.log(`hit@k:      ${(100 * hits / cases.length).toFixed(1)} % (${hits}/${cases.length})`);
  console.log(`preciznost: ${citedTotal ? (100 * citedRelevant / citedTotal).toFixed(1) : '0'} % (${citedRelevant}/${citedTotal} citata)`);
}

main().catch((e) => {
  console.error('Evaluacija nije uspjela:', e);
  process.exit(1);
});
