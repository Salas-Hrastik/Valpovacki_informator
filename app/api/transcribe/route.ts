/**
 * POST /api/transcribe — prijepis govora u tekst (Speech-to-Text).
 *
 * Namjena: glasovni unos na uređajima BEZ Web Speech API-ja (npr. iPhone/Safari).
 * Klijent snimi kratak isječak zvuka i pošalje ga ovamo (multipart/form-data,
 * polje "audio"); server ga proslijedi OpenAI Whisperu i vrati prepoznati tekst.
 *
 * Tijelo (form-data): audio: Blob/File (webm/mp4/ogg/wav…)
 * Odgovor: { text: string }
 */
import { requireEnv } from '@/lib/config';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB — kratki glasovni upiti su mali

export async function POST(req: Request): Promise<Response> {
  try {
    const form = await req.formData();
    const audio = form.get('audio');
    if (!(audio instanceof Blob) || audio.size === 0) {
      return json({ error: 'Nedostaje audio zapis.' }, 400);
    }
    if (audio.size > MAX_BYTES) {
      return json({ error: 'Audio zapis je prevelik.' }, 413);
    }

    // Naziv datoteke s ispravnom ekstenzijom pomaže Whisperu odrediti format.
    const type = audio.type || 'audio/webm';
    const ext = type.includes('mp4') || type.includes('m4a')
      ? 'mp4'
      : type.includes('ogg')
        ? 'ogg'
        : type.includes('wav')
          ? 'wav'
          : 'webm';

    // Jezik prijepisa (višejezično): klijent šalje 'hr' | 'en' | 'de'. Ako izostane
    // ili je nepoznat, izostavljamo hint pa Whisper sam prepoznaje jezik.
    const langRaw = form.get('lang');
    const lang = ['hr', 'en', 'de'].includes(String(langRaw)) ? String(langRaw) : '';

    const oaForm = new FormData();
    oaForm.append('file', audio, `snimka.${ext}`);
    oaForm.append('model', 'whisper-1');
    if (lang) oaForm.append('language', lang); // inače: automatsko prepoznavanje jezika
    oaForm.append('response_format', 'json');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${requireEnv('OPENAI_API_KEY')}` },
      body: oaForm,
      signal: AbortSignal.timeout(25_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('[transcribe] OpenAI greška:', res.status, detail.slice(0, 300));
      return json({ error: 'Prijepis trenutačno nije moguć.' }, 502);
    }

    const data = (await res.json()) as { text?: string };
    return json({ text: (data.text ?? '').trim() });
  } catch (e) {
    console.error('[transcribe] greška:', e);
    return json({ error: 'Došlo je do pogreške pri prijepisu.' }, 500);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
