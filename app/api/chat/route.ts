/**
 * POST /api/chat — RAG chat sa streamingom (SSE).
 *
 * Tijelo zahtjeva: { messages: [{role:"user"|"assistant", content:string}], user_id?: string }
 *
 * Tijek: validacija → rate-limit → embedding upita → retrieve (pgvector + FTS)
 * → sastavljanje poruka za Claude (Messages API, streaming) → SSE prema
 * klijentu (delta tekst + citati) → anonimizirani zapis u conversation_logs.
 *
 * Node runtime: potreban zbog @supabase/supabase-js i dosljednog ponašanja SDK-a.
 */
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'crypto';
import { config } from '@/lib/config';
import { SYSTEM_PROMPT_HR, buildUserPrompt } from '@/lib/prompt';
import { retrieve, uniqueSources } from '@/lib/retrieval';
import { supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_QUESTION_CHARS = 2000;
const MAX_HISTORY_TURNS = 6;

// --- Minimalni rate-limit (po IP-u, u memoriji instance) ---------------------
// Napomena: na serverlessu je ovo "best effort" po instanci; za strožu zaštitu
// preporučuje se Vercel WAF ili Upstash Ratelimit (vidi dokumentaciju projekta).
const RATE_LIMIT = { windowMs: 60_000, max: 20 };
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE_LIMIT.windowMs });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT.max;
}

// ------------------------------------------------------------------------------
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export async function POST(req: Request): Promise<Response> {
  const startedAt = Date.now();

  // Rate-limit po (anonimiziranom) IP-u
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (rateLimited(ip)) {
    return json({ error: 'Previše zahtjeva. Molimo pokušajte ponovno za minutu.' }, 429);
  }

  // Validacija ulaza
  let body: { messages?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Neispravan JSON.' }, 400);
  }
  const messages = sanitizeMessages(body.messages);
  if (!messages || messages.length === 0) {
    return json({ error: 'Polje "messages" je obavezno i mora završavati korisničkom porukom.' }, 400);
  }
  const question = messages[messages.length - 1].content;

  try {
    // 1) Retrieval (embedding upita + pgvector + opcionalni FTS)
    const chunks = await retrieve(question);
    const sources = uniqueSources(chunks);

    // 2) Poruke za Claude: povijest razgovora + zadnje pitanje s kontekstom
    const history = messages.slice(0, -1).slice(-MAX_HISTORY_TURNS);
    const claudeMessages: Anthropic.MessageParam[] = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: buildUserPrompt(question, chunks) },
    ];

    // 3) Streaming odgovor (Messages API)
    const anthropic = new Anthropic(); // čita ANTHROPIC_API_KEY iz okoline
    const stream = anthropic.messages.stream({
      model: config.claudeModel,
      max_tokens: config.claudeMaxTokens,
      system: SYSTEM_PROMPT_HR,
      messages: claudeMessages,
    });

    const encoder = new TextEncoder();
    const sse = (data: object) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        let answer = '';
        try {
          for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              answer += event.delta.text;
              controller.enqueue(sse({ type: 'delta', text: event.delta.text }));
            }
          }
          await stream.finalMessage();
          controller.enqueue(sse({ type: 'sources', sources }));
          controller.enqueue(sse({ type: 'done' }));
        } catch (err) {
          logApiError('[chat] Greška tijekom streama', err);
          controller.enqueue(sse({ type: 'error', error: streamErrorMessage(err) }));
        } finally {
          controller.close();
          // Anonimizirani zapis razgovora (bez PII; hash IP-a sa soli)
          logConversation({
            question,
            answer,
            sources,
            durationMs: Date.now() - startedAt,
            userHash: anonymize(ip),
          }).catch((e) => console.error('[chat] Zapis razgovora nije uspio:', e));
        }
      },
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (err) {
    // 429 (rate limit) i 529 (overloaded) — privremeno stanje, javljamo 503
    if (
      err instanceof Anthropic.RateLimitError ||
      (err instanceof Anthropic.APIError && err.status === 529)
    ) {
      return json({ error: 'Usluga je trenutačno preopterećena. Molimo pokušajte ponovno za nekoliko trenutaka.' }, 503);
    }
    logApiError('[chat] Greška', err);
    return json({ error: 'Došlo je do pogreške. Molimo pokušajte ponovno.' }, 500);
  }
}

// --- Pomoćne funkcije -----------------------------------------------------------

/** Razlučuje uzrok pogreške tijekom streama u razumljivu poruku za građanina.
 *  Generičku granu prati tehnička šifra (HTTP status) radi lakše dijagnostike. */
function streamErrorMessage(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError || (err instanceof Anthropic.APIError && err.status === 529)) {
    return 'Usluga je trenutačno preopterećena. Molimo pokušajte ponovno za nekoliko trenutaka.';
  }
  if (
    err instanceof Anthropic.AuthenticationError ||
    (err instanceof Anthropic.APIError && (err.status === 401 || err.status === 403))
  ) {
    return 'Usluga trenutačno nije ispravno postavljena (pristup). Molimo obavijestite administratora.';
  }
  if (err instanceof Anthropic.APIError && err.status === 404) {
    return 'Tražena usluga (jezični model) trenutačno nije dostupna. Molimo obavijestite administratora.';
  }
  if (err instanceof Anthropic.APIError && err.status === 400) {
    return 'Zahtjev nije prihvaćen (moguće stanje računa ili ograničenja). Molimo obavijestite administratora. (šifra 400)';
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return 'Usluga predugo ne odgovara (istek veze). Molimo pokušajte ponovno.';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Trenutačno se nije moguće povezati s uslugom. Molimo pokušajte ponovno.';
  }
  // Privremena dijagnostika: za neočekivane (ne-API) pogreške prikazujemo tip i
  // (skraćeni) tekst iznimke kako bismo precizno odredili uzrok; uklanja se nakon dijagnoze.
  const code = err instanceof Anthropic.APIError && err.status ? ` (šifra ${err.status})` : '';
  const type = err instanceof Error && err.name ? ` (tip: ${err.name})` : '';
  const detail =
    err instanceof Error && err.message
      ? ` (detalji: ${err.message.replace(/\s+/g, ' ').slice(0, 160)})`
      : '';
  return `Došlo je do pogreške pri generiranju odgovora. Molimo pokušajte ponovno${code}${type}${detail}.`;
}

/** Strukturirani zapis API-pogreške (status/naziv/poruka vidljivi u Vercel logovima). */
function logApiError(label: string, err: unknown): void {
  if (err instanceof Anthropic.APIError) {
    console.error(`${label}:`, { name: err.name, status: err.status, message: err.message });
  } else {
    console.error(`${label}:`, err);
  }
}

function sanitizeMessages(raw: unknown): ChatMessage[] | null {
  if (!Array.isArray(raw)) return null;
  const cleaned: ChatMessage[] = [];
  for (const m of raw.slice(-2 * MAX_HISTORY_TURNS - 1)) {
    if (
      m && typeof m === 'object' &&
      (m as ChatMessage).role !== undefined &&
      ['user', 'assistant'].includes((m as ChatMessage).role) &&
      typeof (m as ChatMessage).content === 'string'
    ) {
      const content = (m as ChatMessage).content.trim().slice(0, MAX_QUESTION_CHARS);
      if (content) cleaned.push({ role: (m as ChatMessage).role, content });
    }
  }
  if (cleaned.length === 0 || cleaned[cleaned.length - 1].role !== 'user') return null;
  return cleaned;
}

function anonymize(ip: string): string {
  const salt = process.env.VERCEL_CRON_SECRET ?? 'valpovo-salt';
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 16);
}

async function logConversation(entry: {
  question: string;
  answer: string;
  sources: object[];
  durationMs: number;
  userHash: string;
}): Promise<void> {
  await supabaseAdmin().from('conversation_logs').insert({
    question: entry.question,
    answer: entry.answer,
    sources: entry.sources,
    duration_ms: entry.durationMs,
    model: config.claudeModel,
    user_hash: entry.userHash,
  });
}

function json(data: object, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
