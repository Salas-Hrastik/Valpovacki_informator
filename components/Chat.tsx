'use client';

/**
 * Glavna chat komponenta — koristi se na početnoj stranici i u embed widgetu.
 * Čita SSE stream s /api/chat i prikazuje odgovor s citatima izvora.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Source {
  title: string;
  url: string;
  score: number;
  fetched_at: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
}

// Brzi prijedlozi pitanja — prikazuju se na početku da građanin odmah vidi
// što može pitati. Klik šalje pitanje izravno. Odabrane su teme od najšireg
// interesa za građane Valpova i prigradskih naselja.
const PRIJEDLOZI = [
  'Kada se održava Ljeto valpovačko?',
  'Koji su aktualni natječaji i javni pozivi?',
  'Koje je radno vrijeme gradske uprave?',
  'Gdje i koliko se plaća parkiranje?',
  'Kako platiti komunalnu naknadu?',
  'Kako se prijaviti za dječji vrtić?',
];

// Minimalni tip za Web Speech API (nije u standardnim TS lib tipovima).
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function formatDateHr(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}.`;
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  // Indeks poruke čiji je skočni prozor s izvorima trenutačno otvoren (ili null).
  const [sourcesIdx, setSourcesIdx] = useState<number | null>(null);
  // Glasovni unos (Web Speech API): podržanost, je li snimanje u tijeku te
  // "glasovni razgovor" (hands-free: nakon stanke se pitanje šalje samo, a nakon
  // odgovora se ponovno sluša — dok korisnik ne zaustavi).
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceModeRef = useRef(false);
  const transcriptRef = useRef('');
  const busyRef = useRef(false);
  const pendingRef = useRef('');

  // Provjera podrške za glasovni unos (samo u pregledniku).
  useEffect(() => {
    const w = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    setVoiceSupported(!!(w.SpeechRecognition || w.webkitSpeechRecognition));
  }, []);

  // Zatvaranje skočnog prozora s izvorima tipkom Esc.
  useEffect(() => {
    if (sourcesIdx === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSourcesIdx(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sourcesIdx]);

  const scrollDown = () =>
    requestAnimationFrame(() => listRef.current?.scrollTo({ top: 1e9, behavior: 'smooth' }));

  // Polje za unos raste s tekstom (do razumne visine), pa se vraća na jedan red.
  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };
  const resetInputHeight = () => {
    if (taRef.current) taRef.current.style.height = 'auto';
  };

  // Reset razgovora — praznimo poruke (dobrodošlica je stalno ispod naslova).
  const newConversation = () => {
    if (busy) return;
    voiceModeRef.current = false;
    pendingRef.current = '';
    setVoiceMode(false);
    recognitionRef.current?.stop();
    setMessages([]);
    setInput('');
    resetInputHeight();
    setCopiedIdx(null);
    setSourcesIdx(null);
  };

  // Kopiranje odgovora u međuspremnik uz kratku potvrdu.
  const copyAnswer = async (text: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1500);
    } catch {
      /* clipboard nedostupan (npr. nesiguran kontekst) — tiho ignoriraj */
    }
  };

  const send = useCallback(async (preset?: string) => {
    const question = (preset ?? input).trim();
    if (!question || busy) return;
    if (preset === undefined) {
      setInput('');
      resetInputHeight();
    }
    setBusy(true);

    const history = messages;
    const next: Message[] = [...messages, { role: 'user', content: question }];
    setMessages([...next, { role: 'assistant', content: '' }]);
    scrollDown();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...history.map(({ role, content }) => ({ role, content })), { role: 'user', content: question }],
        }),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
      }

      // Čitanje SSE streama
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const apply = (updater: (m: Message) => Message) =>
        setMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = updater(copy[copy.length - 1]);
          return copy;
        });

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const raw of events) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          const data = JSON.parse(line.slice(5));
          if (data.type === 'delta') {
            apply((m) => ({ ...m, content: m.content + data.text }));
            scrollDown();
          } else if (data.type === 'sources') {
            apply((m) => ({ ...m, sources: data.sources }));
          } else if (data.type === 'error') {
            apply((m) => ({ ...m, content: m.content || data.error }));
          }
        }
      }
    } catch (e) {
      setMessages((prev) => {
        const copy = [...prev];
        copy[copy.length - 1] = {
          role: 'assistant',
          content:
            e instanceof Error && e.message
              ? e.message
              : 'Došlo je do pogreške. Molimo pokušajte ponovno.',
        };
        return copy;
      });
    } finally {
      setBusy(false);
      scrollDown();
    }
  }, [input, busy, messages]);

  // Najsvježija verzija send + status zauzetosti dostupni unutar callbackova
  // prepoznavanja govora (koji se izvršavaju izvan React render-ciklusa).
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // Pokreni jedan ciklus slušanja. Po završetku govora (kratka stanka): ako je
  // nešto izgovoreno, pitanje se ŠALJE automatski; ako nije, ciklus se obnavlja
  // (preko efekta niže) dok je glasovni razgovor uključen.
  const startListening = useCallback(() => {
    if (recognitionRef.current) return;
    const w = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return;
    transcriptRef.current = '';
    const rec = new Ctor();
    rec.lang = 'hr-HR';
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (event) => {
      let text = '';
      for (let i = 0; i < event.results.length; i++) text += event.results[i][0].transcript;
      transcriptRef.current = text;
      setInput(text);
      if (taRef.current) autoGrow(taRef.current);
    };
    rec.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      if (!voiceModeRef.current) return;
      const text = transcriptRef.current.trim();
      if (text) {
        setInput('');
        resetInputHeight();
        if (busyRef.current) {
          // Odgovor je još u tijeku — zapamti pitanje i pošalji ga čim završi.
          pendingRef.current = text;
        } else {
          void sendRef.current(text); // auto-slanje nakon stanke
        }
      }
      // Slušanje se obnavlja preko efekta niže (i tijekom odgovora i nakon njega).
    };
    rec.onerror = () => {
      recognitionRef.current = null;
      setListening(false);
    };
    recognitionRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      /* već pokrenut — zanemari */
    }
  }, []);

  // U glasovnom razgovoru slušanje je KONTINUIRANO: kad ne slušamo, ponovno
  // pokreni slušanje — i tijekom odgovora i nakon njega (te nakon tišine).
  // Stop gasi cijeli mod.
  useEffect(() => {
    if (!voiceMode || listening || recognitionRef.current) return;
    const t = window.setTimeout(() => {
      if (voiceModeRef.current && !recognitionRef.current) startListening();
    }, 500);
    return () => window.clearTimeout(t);
  }, [voiceMode, listening, startListening]);

  // Kad odgovor završi (busy → false), pošalji pitanje koje je izgovoreno usred
  // odgovora (čekalo je u redu).
  useEffect(() => {
    if (busy || !voiceMode || !pendingRef.current) return;
    const q = pendingRef.current;
    pendingRef.current = '';
    void sendRef.current(q);
  }, [busy, voiceMode]);

  const startVoiceMode = () => {
    if (busy) return;
    voiceModeRef.current = true;
    setVoiceMode(true);
    startListening();
  };
  const stopVoiceMode = () => {
    voiceModeRef.current = false;
    pendingRef.current = '';
    setVoiceMode(false);
    setListening(false);
    recognitionRef.current?.stop();
    recognitionRef.current = null;
  };

  return (
    <div className="chat" aria-busy={busy}>
      {messages.length > 0 && (
        <div className="chat-toolbar">
          <button type="button" className="chat-reset" onClick={newConversation} disabled={busy}>
            ↺ Novi razgovor
          </button>
        </div>
      )}
      <div
        className="chat-messages"
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Razgovor s informatorom"
      >
        {messages.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>
            <div className="msg-bubble">
              {m.content ? (
                <div className="msg-text">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      // Poveznice se otvaraju u novoj kartici, sigurno (noopener).
                      a: ({ node, ...props }) => (
                        <a target="_blank" rel="noopener noreferrer" {...props} />
                      ),
                    }}
                  >
                    {m.content}
                  </ReactMarkdown>
                </div>
              ) : busy && i === messages.length - 1 ? (
                <span className="typing" aria-label="Asistent piše odgovor" role="status">
                  <span></span>
                  <span></span>
                  <span></span>
                </span>
              ) : (
                ''
              )}
              {m.sources && m.sources.length > 0 && (
                <button
                  type="button"
                  className="msg-sources-btn"
                  onClick={() => setSourcesIdx(i)}
                  aria-haspopup="dialog"
                >
                  Izvori ({m.sources.length})
                </button>
              )}
              {m.role === 'assistant' && i > 0 && m.content && !(busy && i === messages.length - 1) && (
                <button
                  type="button"
                  className="msg-copy"
                  onClick={() => void copyAnswer(m.content, i)}
                  aria-label="Kopiraj odgovor"
                >
                  {copiedIdx === i ? '✓ Kopirano' : '⧉ Kopiraj'}
                </button>
              )}
            </div>
          </div>
        ))}

        {messages.length === 0 && !busy && (
          <div className="chat-suggestions" aria-label="Prijedlozi pitanja">
            {PRIJEDLOZI.map((q) => (
              <button key={q} type="button" className="chip" onClick={() => void send(q)}>
                {q}
              </button>
            ))}
          </div>
        )}
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={taRef}
          rows={1}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            autoGrow(e.currentTarget);
          }}
          onKeyDown={(e) => {
            // Enter šalje; Shift+Enter umeće novi red.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={listening ? 'Slušam… izgovorite pitanje' : 'Postavite pitanje o Gradu Valpovu…'}
          maxLength={2000}
          disabled={busy}
          aria-label="Vaše pitanje"
        />
        {voiceSupported && (
          voiceMode ? (
            <button
              type="button"
              className="chat-mic listening"
              onClick={stopVoiceMode}
              aria-pressed={true}
              aria-label="Završi glasovni razgovor"
              title="Završi glasovni razgovor"
            >
              ⏹
            </button>
          ) : (
            <button
              type="button"
              className="chat-mic"
              onClick={startVoiceMode}
              disabled={busy}
              aria-label="Pokreni glasovni razgovor"
              title="Pokreni glasovni razgovor"
            >
              🎤
            </button>
          )
        )}
        <button type="submit" disabled={busy || !input.trim()}>
          Pošalji
        </button>
      </form>

      <p className="chat-disclaimer">
        Odgovore generira umjetna inteligencija na temelju javno dostupnih službenih izvora i mogu
        sadržavati pogreške. Za pravno obvezujuće informacije obratite se Gradu Valpovu
        (<a href="https://valpovo.hr" target="_blank" rel="noopener noreferrer">valpovo.hr</a>).
        Molimo ne unosite osobne podatke.
      </p>

      {sourcesIdx !== null && messages[sourcesIdx]?.sources && (
        <div
          className="sources-modal-backdrop"
          role="presentation"
          onClick={() => setSourcesIdx(null)}
        >
          <div
            className="sources-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Izvori"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sources-modal-head">
              <strong>Izvori</strong>
              <button
                type="button"
                className="sources-modal-close"
                onClick={() => setSourcesIdx(null)}
                aria-label="Zatvori"
              >
                ✕
              </button>
            </div>
            <ul>
              {messages[sourcesIdx]!.sources!.map((s) => (
                <li key={s.url}>
                  <a href={s.url} target="_blank" rel="noopener noreferrer">
                    {s.title}
                  </a>{' '}
                  <span className="msg-source-date">(provjereno: {formatDateHr(s.fetched_at)})</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
