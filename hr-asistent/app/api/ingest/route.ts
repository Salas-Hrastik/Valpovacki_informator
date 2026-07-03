/**
 * GET/POST /api/ingest — pokretanje ingestije knjige na poslužitelju.
 *
 * Korpus je KNJIGA (mapa knowledge/ u deployu), pa za razliku od web-informatora
 * NEMA cron rasporeda — ingestija se pokreće jednokratno nakon (re)deploya s
 * novom/izmijenjenom knjigom, ili lokalno s `npm run ingest`.
 *
 * Autorizacija: zaglavlje "x-ingest-secret: <INGEST_SECRET>",
 * "Authorization: Bearer <INGEST_SECRET>" ili ?key=<INGEST_SECRET> u adresi.
 *
 * Parametri: ?prune=1 — ukloni iz baze odjeljke kojih više nema u knjizi.
 *
 * Trajanje: maxDuration = 300 s (Vercel Pro; na Hobby planu smanjite na 60).
 * Ingestija je inkrementalna (hash sadržaja) pa se velika knjiga po potrebi
 * dovrši kroz nekoliko uzastopnih pokretanja.
 */
import { runIngest } from '@/lib/ingest/pipeline';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function authorized(req: Request): boolean {
  const secret = process.env.INGEST_SECRET || process.env.CRON_SECRET;
  if (!secret) return false; // bez tajne ne dopuštamo pokretanje
  const bearer = req.headers.get('authorization');
  const custom = req.headers.get('x-ingest-secret');
  const key = new URL(req.url).searchParams.get('key');
  return bearer === `Bearer ${secret}` || custom === secret || key === secret;
}

async function handle(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return new Response(JSON.stringify({ error: 'Neovlašteno.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const prune = new URL(req.url).searchParams.get('prune') === '1';
  // 280 s vlastitog limita ostavlja prostor za uredno zatvaranje prije 300 s
  const stats = await runIngest({ deadlineMs: 280_000, prune });

  return new Response(JSON.stringify({ ok: true, stats }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET = handle;   // ručno pokretanje otvaranjem poveznice (?key=…)
export const POST = handle;  // ručno pokretanje (curl)
