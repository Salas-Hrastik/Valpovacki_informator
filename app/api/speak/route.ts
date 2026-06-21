/**
 * POST /api/speak — sinteza govora (Text-to-Speech) prirodnim glasom.
 *
 * Sustavni (preglednički) TTS, osobito hrvatski na iOS-u, zvuči robotski. Ovdje
 * koristimo OpenAI TTS koji daje znatno prirodniji ženski glas. Klijent šalje
 * čisti tekst (bez emojija/markdowna), a vraćamo mp3 audio.
 *
 * Tijelo: { text: string }
 * Odgovor: audio/mpeg (mp3)
 */
import { requireEnv } from '@/lib/config';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  try {
    const { text } = (await req.json()) as { text?: string };
    const clean = (text ?? '').trim().slice(0, 3000); // sigurnosna granica
    if (!clean) {
      return json({ error: 'Nedostaje tekst.' }, 400);
    }

    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${requireEnv('OPENAI_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts', // prirodan, brz; "nova" = topao ženski glas
        voice: 'nova',
        input: clean,
        response_format: 'mp3',
        instructions: 'Govori na hrvatskom jeziku, prirodno, toplo i jasno, umjerenim tempom.',
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('[speak] OpenAI greška:', res.status, detail.slice(0, 300));
      return json({ error: 'Sinteza govora trenutačno nije moguća.' }, 502);
    }

    const audio = await res.arrayBuffer();
    return new Response(audio, {
      headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    console.error('[speak] greška:', e);
    return json({ error: 'Došlo je do pogreške pri sintezi govora.' }, 500);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
