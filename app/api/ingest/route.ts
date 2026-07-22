/**
 * GET/POST /api/ingest — pokretanje ingestije (Vercel Cron).
 *
 * Raspored (vercel.json):
 *  - Svaki dan (pon–sub) 03:00 UTC: ?scope=daily — dnevno osvježavanje SVIH
 *    izvora o Valpovu uz kratak prozor svježine (dailyFreshDays). Novi sadržaj
 *    ima prioritet; veliki se korpus osvježava rotacijom kroz uzastopna pokretanja.
 *  - Nedjeljom 02:00 UTC: bez parametra — veliki prolaz svih izvora (rezerva).
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
  // Ručno pokretanje iz preglednika: dopuštamo i ?key=<CRON_SECRET> u adresi, da
  // administrator može pokrenuti ingest jednostavnim otvaranjem poveznice.
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

  // scope=daily (ili homepage) → DNEVNO osvježavanje SVIH izvora o Valpovu uz
  // kratak prozor svježine (dailyFreshDays); inače (nedjeljom) veliki prolaz svih
  // izvora s uobičajenim prozorom. Novi sadržaj ima prioritet, a veliki se korpus
  // osvježava rotacijom kroz uzastopna pokretanja.
  const params = new URL(req.url).searchParams;
  const scope = params.get('scope');
  const isDaily = scope === 'daily' || scope === 'homepage';
  // Najciljanije: ?only=url1,url2 obrađuje SAMO te stranice (+ PDF/slike koje na
  // njima otkrije) i forsira obradu — npr. stranica Službenih glasnika i svi njezini
  // PDF-ovi, bez trošenja vremena na ostatak sjedišta.
  const onlyParam = params.get('only');
  const onlyUrls = onlyParam
    ? onlyParam.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  // Ciljano ručno pokretanje: ?hosts=domena1,domena2 obrađuje SAMO te domene i
  // forsira osvježavanje (freshDays=0) — brzo povlačenje pojedinih izvora.
  const hostsParam = params.get('hosts');
  const explicitHosts = hostsParam
    ? hostsParam.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const onlyHosts = explicitHosts ?? undefined; // dnevno i nedjeljno = SVI izvori
  const freshDays = explicitHosts ? 0 : isDaily ? config.dailyFreshDays : undefined;

  // 280 s vlastitog limita ostavlja prostor za uredno zatvaranje prije 300 s
  const stats = await runIngest({ deadlineMs: 280_000, onlyUrls, onlyHosts, freshDays });

  const scopeLabel = onlyUrls ? 'only' : (scope ?? (explicitHosts ? 'hosts' : 'full'));
  return new Response(JSON.stringify({ ok: true, scope: scopeLabel, stats }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET = handle;   // Vercel Cron poziva GET
export const POST = handle;  // ručno pokretanje (curl)
