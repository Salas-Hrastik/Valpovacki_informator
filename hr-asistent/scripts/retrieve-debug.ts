/**
 * Dijagnostika dohvata (RAG) — pokazuje GDJE neki odjeljak knjige pada u pretraživanju.
 *
 *   npm run rag:debug -- "Koje su faze procesa selekcije?"
 *   npm run rag:debug -- "Koje su faze procesa selekcije?" --find=selekcij
 *
 * Ispisuje top rezultate vektorskog i leksičkog (FTS) kanala s rezultatom
 * (score) i rangom, te POSEBNO gdje se nalazi traženi odjeljak (--find = dio
 * interne oznake knjiga://…). Tako vidimo je li ispod praga sličnosti, izvan
 * skupa kandidata ili ga reranker izbaci. Treba SUPABASE_URL + SERVICE_ROLE_KEY
 * i embedding ključ (kao ingest) — iz okoline ili .env.local.
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

function loadEnvLocal(): void {
  const file = resolve(process.cwd(), '.env.local');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvLocal();

function lexicalQuery(query: string): string {
  const words = query.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter((w) => w.length >= 4);
  return words.length > 0 ? words.join(' ') : query;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const query = args.filter((a) => !a.startsWith('--')).join(' ').trim();
  const find = (args.find((a) => a.startsWith('--find=')) || '--find=selekcij').split('=')[1];
  if (!query) {
    console.error('Uporaba: npm run rag:debug -- "<pitanje>" [--find=<dio-oznake-odjeljka>]');
    process.exit(2);
  }

  const { embedText } = await import('../lib/embeddings');
  const { supabaseAdmin } = await import('../lib/supabase');
  const { config } = await import('../lib/config');
  const sb = supabaseAdmin();

  console.log(`[rag-debug] Pitanje: "${query}"`);
  console.log(`[rag-debug] Tražim odjeljak koji sadrži: "${find}"`);
  console.log(`[rag-debug] Prag sličnosti (RAG_SCORE_THRESHOLD) = ${config.ragScoreThreshold}\n`);

  const emb = await embedText(query);

  // Vektorski kanal BEZ praga (threshold=0) i sa širokim brojem, da vidimo pravi rang/score.
  const { data: vec, error: vErr } = await sb.rpc('match_chunks', {
    query_embedding: JSON.stringify(emb),
    match_count: 100,
    score_threshold: 0,
  });
  if (vErr) throw new Error(`match_chunks: ${vErr.message}`);
  const vrows = (vec ?? []) as { url: string; title: string; score: number }[];

  console.log('═══ VEKTORSKI kanal (top 15 od 100, prag 0) ═══');
  vrows.slice(0, 15).forEach((r, i) => {
    const mark = r.url.includes(find) ? '  <<< TRAŽENI' : '';
    console.log(`  ${String(i + 1).padStart(3)}. ${r.score.toFixed(3)}  ${r.title?.slice(0, 60) || r.url}${mark}`);
  });
  const vHit = vrows.findIndex((r) => r.url.includes(find));
  console.log(
    vHit >= 0
      ? `\n  → TRAŽENI je na rangu ${vHit + 1}/100, score ${vrows[vHit].score.toFixed(3)} ` +
          `(${vrows[vHit].score >= config.ragScoreThreshold ? 'IZNAD' : 'ISPOD'} praga ${config.ragScoreThreshold})`
      : '\n  → TRAŽENI NIJE među top 100 vektorskih rezultata.',
  );

  // Leksički (FTS) kanal
  const { data: fts, error: fErr } = await sb.rpc('search_chunks_fts', {
    query_text: lexicalQuery(query),
    match_count: 100,
  });
  if (fErr) console.log(`\n[FTS] greška: ${fErr.message}`);
  const frows = (fts ?? []) as { url: string; title: string; score: number }[];
  console.log('\n═══ LEKSIČKI (FTS) kanal (top 15 od 100) ═══');
  frows.slice(0, 15).forEach((r, i) => {
    const mark = r.url.includes(find) ? '  <<< TRAŽENI' : '';
    console.log(`  ${String(i + 1).padStart(3)}. ${r.score?.toFixed?.(3) ?? r.score}  ${r.title?.slice(0, 60) || r.url}${mark}`);
  });
  const fHit = frows.findIndex((r) => r.url.includes(find));
  console.log(fHit >= 0 ? `\n  → TRAŽENI je na FTS rangu ${fHit + 1}/100.` : '\n  → TRAŽENI NIJE među top 100 FTS rezultata.');

  console.log('\n[rag-debug] Gotovo. Pošalji ovaj ispis pa znamo točan uzrok i lijek.');
}

main().catch((e) => {
  console.error('[rag-debug] Greška:', e);
  process.exit(1);
});
