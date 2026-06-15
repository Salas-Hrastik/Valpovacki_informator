'use client';

/**
 * Glavna chat komponenta — koristi se na početnoj stranici i u embed widgetu.
 * Čita SSE stream s /api/chat i prikazuje odgovor s citatima izvora.
 */
import { useCallback, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';

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

const UVODNA_PORUKA =
  'Poštovani, dobro došli! Ja sam Valpovački AI gradski informator. ' +
  'Slobodno me pitajte o uslugama gradske uprave, natječajima, komunalnim temama, ' +
  'ustanovama i događanjima u Gradu Valpovu i pripadajućim naseljima.';

function formatDateHr(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}.`;
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: UVODNA_PORUKA },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

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

  const send = useCallback(async () => {
    const question = input.trim();
    if (!question || busy) return;
    setInput('');
    resetInputHeight();
    setBusy(true);

    const history = messages.filter((m, i) => !(i === 0 && m.role === 'assistant'));
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

  return (
    <div className="chat">
      <div className="chat-messages" ref={listRef}>
        {messages.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>
            <div className="msg-bubble">
              {m.content ? (
                <div className="msg-text">
                  <ReactMarkdown
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
                <div className="msg-sources">
                  <strong>Izvori:</strong>
                  <ul>
                    {m.sources.map((s) => (
                      <li key={s.url}>
                        <a href={s.url} target="_blank" rel="noopener noreferrer">
                          {s.title}
                        </a>{' '}
                        <span className="msg-source-date">(provjereno: {formatDateHr(s.fetched_at)})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        ))}
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
          placeholder="Postavite pitanje o Gradu Valpovu…"
          maxLength={2000}
          disabled={busy}
          aria-label="Vaše pitanje"
        />
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
    </div>
  );
}
