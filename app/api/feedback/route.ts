/**
 * POST /api/feedback — ocjena korisnika za zadnji odgovor (1–5).
 * Tijelo: { log_id?: string, rating: number }
 * Ako log_id nije poznat (stream ga ne vraća), ocjenjuje se najnoviji zapis
 * istog anonimiziranog korisnika unutar zadnjih 10 minuta.
 */
import { createHash } from 'crypto';
import { supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  let body: { log_id?: string; rating?: number };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Neispravan JSON.' }), { status: 400 });
  }

  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return new Response(JSON.stringify({ error: 'Ocjena mora biti cijeli broj 1–5.' }), { status: 400 });
  }

  const sb = supabaseAdmin();

  if (body.log_id) {
    await sb.from('conversation_logs').update({ rating }).eq('id', body.log_id);
    return new Response(JSON.stringify({ ok: true }));
  }

  // Bez log_id: ocijeni najnoviji nedavni zapis istog (anonimiziranog) korisnika
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const salt = process.env.VERCEL_CRON_SECRET ?? 'valpovo-salt';
  const userHash = createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 16);

  const { data } = await sb
    .from('conversation_logs')
    .select('id')
    .eq('user_hash', userHash)
    .gte('created_at', new Date(Date.now() - 10 * 60_000).toISOString())
    .order('created_at', { ascending: false })
    .limit(1);

  if (data && data.length > 0) {
    await sb.from('conversation_logs').update({ rating }).eq('id', data[0].id);
  }
  return new Response(JSON.stringify({ ok: true }));
}
