/**
 * GET/POST /api/ingest — pokretanje ingestije (Vercel Cron).
 *
 * Raspored (vercel.json):
 *  - Svaki dan (pon–sub) 03:00 UTC: ?scope=daily — brzo dnevno osvježavanje
 *    vijesti (valpovo.hr) i DOGAĐANJA (ustanova.valpovo.hr, tz.valpovo.hr), gdje
 *    se sadržaj stalno mijenja. Kratki prozor svježine (dailyFreshDays) osigurava
 *    da se te stranice uistinu osvježe svaki dan.
 *  - Nedjeljom 02:00 UTC: bez parametra — veliko ažuriranje SVIH izvora.
 *
 * Autorizacija:
 *  - Vercel Cron šalje zaglavlje "Authorization: Bearer <CRON_SECRET>" kada je
 *    u projektu postavljena ENV varijabla CRON_SECRET; ručni pozivi prihvaćaju
 *    se i kroz zaglavlje "x-ingest-secret".
 *
 * Trajanje: maxDuration = 300 s (Vercel Pro). Ingestija ima vlastiti vremenski
 * limit (deadlineMs) i obrađuje najviše INGEST_MAX_URLS po pokretanju —
 * nepromijenjeni dokumenti se preskaču pa se veliki korpusi "dovrše" kroz
 * nekoliko uzastopnih pokretanja.
 */
import { config } from '@/lib/config';
import { runIngest } from '@/lib/ingest/pipeline';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;
  if (!secret) return false; // bez tajne ne dopuštamo pokretanje
  const bearer = req.headers.get('authorization');
  const custom = req.headers.get('x-ingest-secret');
  return bearer === `Bearer ${secret}` || custom === secret;
}

async function handle(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return new Response(JSON.stringify({ error: 'Neovlašteno.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // scope=daily (ili homepage) → dnevno osvježavanje vijesti + događanja (uži skup
  // domena, kratki prozor svježine); inače veliko ažuriranje svih izvora (nedjeljom).
  const scope = new URL(req.url).searchParams.get('scope');
  const isDaily = scope === 'daily' || scope === 'homepage';
  const onlyHosts = isDaily ? config.dailyHosts : undefined;
  const freshDays = isDaily ? config.dailyFreshDays : undefined;

  // 280 s vlastitog limita ostavlja prostor za uredno zatvaranje prije 300 s
  const stats = await runIngest({ deadlineMs: 280_000, onlyHosts, freshDays });

  return new Response(JSON.stringify({ ok: true, scope: scope ?? 'full', stats }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET = handle;   // Vercel Cron poziva GET
export const POST = handle;  // ručno pokretanje (curl)
