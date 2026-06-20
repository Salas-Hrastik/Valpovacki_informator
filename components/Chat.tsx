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
  onerror: ((event: { error?: string }) => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function formatDateHr(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}.`;
}

// Markdown → čisti tekst za izgovor (bez #, *, `, poveznica, tablica…).
function toSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // poveznice → samo tekst
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_~>#|]/g, ' ')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Odabir ugodnog ŽENSKOG glasa — prednost hrvatskom, pa poznatim ženskim glasovima.
function chooseVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (!voices.length) return null;
  const female = /female|žensk|woman|zira|jelena|lana|gabrijela|matea|petra|google hrvatski|samantha|tessa|serena|amelie|google uk english female/i;
  const male = /male|mušk|man|matej|david|mark|google.*male/i;
  const hr = voices.filter((v) => /^hr/i.test(v.lang));
  return (
    hr.find((v) => female.test(v.name)) ||
    hr.find((v) => !male.test(v.name)) ||
    hr[0] ||
    voices.find((v) => female.test(v.name)) ||
    null
  );
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
  const [speaking, setSpeaking] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceModeRef = useRef(false);
  const transcriptRef = useRef('');
  const busyRef = useRef(false);
  const pendingRef = useRef('');
  const speakingRef = useRef(false);
  const ttsVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const ttsKeepAliveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const lastSpokenRef = useRef('');
  // Fallback glasovni unos SNIMANJEM (za uređaje bez Web Speech API-ja, npr. iPhone):
  // snimi zvuk pa pošalji /api/transcribe (Whisper). useRecorderRef = koristi se taj put.
  const useRecorderRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Provjera podrške za glasovni unos. Prednost Web Speech API-ju; ako ga nema
  // (npr. iPhone/Safari), koristimo snimanje + /api/transcribe.
  useEffect(() => {
    const w = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const webSpeech = !!(w.SpeechRecognition || w.webkitSpeechRecognition);
    const recorder =
      typeof MediaRecorder !== 'undefined' &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function';
    useRecorderRef.current = !webSpeech && recorder;
    setVoiceSupported(webSpeech || recorder);
  }, []);

  // Učitavanje i odabir ženskog glasa za izgovor (lista glasova stiže asinkrono).
  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    const pick = () => {
      ttsVoiceRef.current = chooseVoice(window.speechSynthesis.getVoices());
    };
    pick();
    window.speechSynthesis.onvoiceschanged = pick;
    return () => {
      window.speechSynthesis.cancel();
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  // Najsvježija lista poruka dostupna izvan render-ciklusa (za izgovor odgovora).
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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
    lastSpokenRef.current = '';
    setVoiceMode(false);
    recognitionRef.current?.stop();
    try {
      mediaRecorderRef.current?.stop();
    } catch {
      /* ignoriraj */
    }
    cleanupRecording();
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
    speakingRef.current = false;
    setSpeaking(false);
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
    rec.onerror = (event) => {
      recognitionRef.current = null;
      setListening(false);
      const err = event?.error;
      // Fatalne greške (nema dopuštenja/mikrofona) — ugasi mod da ne vrti u krug.
      if (err === 'not-allowed' || err === 'service-not-allowed' || err === 'audio-capture') {
        voiceModeRef.current = false;
        setVoiceMode(false);
      }
      // 'no-speech'/'aborted' su normalni — efekt niže opet pokrene slušanje.
    };
    recognitionRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      /* već pokrenut — zanemari */
    }
  }, []);

  // Izgovori tekst odgovora ženskim glasom (samo tekst, bez izvora). Dok bot
  // govori, mikrofon je pauziran (da se ne čuje sam); po završetku se slušanje
  // automatski nastavlja (preko efekta niže).
  const speak = useCallback((text: string) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    const clean = toSpeech(text);
    if (!clean) return;
    const synth = window.speechSynthesis;
    // mikrofon off dok bot govori (oba puta unosa)
    recognitionRef.current?.stop();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = 'hr-HR';
    if (ttsVoiceRef.current) u.voice = ttsVoiceRef.current;
    u.rate = 1;
    u.pitch = 1.05; // malo topliji, ugodniji ton
    const clearKeepAlive = () => {
      if (ttsKeepAliveRef.current) {
        clearInterval(ttsKeepAliveRef.current);
        ttsKeepAliveRef.current = null;
      }
    };
    u.onstart = () => {
      speakingRef.current = true;
      setSpeaking(true);
      // Chrome zaustavi govor nakon ~15 s — periodični resume to sprječava.
      clearKeepAlive();
      ttsKeepAliveRef.current = setInterval(() => {
        try {
          window.speechSynthesis.pause();
          window.speechSynthesis.resume();
        } catch {
          /* ignoriraj */
        }
      }, 10000);
    };
    const done = () => {
      clearKeepAlive();
      speakingRef.current = false;
      setSpeaking(false);
    };
    u.onend = done;
    u.onerror = done;
    try {
      synth.resume(); // ako je u pauziranom stanju
    } catch {
      /* ignoriraj */
    }
    synth.speak(u);
  }, []);

  // Počisti resurse snimanja (timeri, audio kontekst, mikrofonski tokovi).
  const cleanupRecording = useCallback(() => {
    for (const ref of [silenceTimerRef, idleTimerRef, maxTimerRef]) {
      if (ref.current) {
        clearTimeout(ref.current);
        ref.current = null;
      }
    }
    try {
      audioCtxRef.current?.close();
    } catch {
      /* ignoriraj */
    }
    audioCtxRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
  }, []);

  // Fallback unos SNIMANJEM (iPhone/Safari): snimi zvuk, automatski stani nakon
  // kratke tišine, pošalji /api/transcribe (Whisper) i tretiraj prijepis kao
  // izgovoreno pitanje. "listening" ostaje uključen tijekom prijepisa da se ne
  // pokrene novi ciklus prerano.
  const startRecordingCycle = useCallback(async () => {
    if (mediaRecorderRef.current) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      voiceModeRef.current = false; // dopuštenje odbijeno / nema mikrofona
      setVoiceMode(false);
      setListening(false);
      return;
    }
    if (!voiceModeRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    mediaStreamRef.current = stream;
    const mr = new MediaRecorder(stream);
    mediaRecorderRef.current = mr;
    const chunks: BlobPart[] = [];
    let speechDetected = false;

    mr.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    mr.onstop = async () => {
      const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
      cleanupRecording();
      // Tišina ili prekratko → ne šaljemo na prijepis; samo nastavi slušati.
      if (!voiceModeRef.current || !speechDetected || blob.size < 1500) {
        setListening(false);
        return;
      }
      try {
        const fd = new FormData();
        fd.append('audio', blob, 'snimka');
        const r = await fetch('/api/transcribe', { method: 'POST', body: fd });
        const data = (await r.json().catch(() => ({}))) as { text?: string };
        const text = (data.text || '').trim();
        setListening(false);
        if (text && voiceModeRef.current) {
          setInput('');
          resetInputHeight();
          if (busyRef.current) pendingRef.current = text;
          else void sendRef.current(text);
        }
      } catch {
        setListening(false);
      }
    };

    const stopIfRecording = () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
    };

    // Detekcija tišine preko jakosti zvuka (RMS).
    try {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!audioCtxRef.current || !mediaRecorderRef.current) return;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        if (Math.sqrt(sum / buf.length) > 0.045) {
          if (!speechDetected) {
            speechDetected = true;
            if (idleTimerRef.current) clearTimeout(idleTimerRef.current); // čuo se govor
          }
          if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = setTimeout(stopIfRecording, 1400); // ~1,4 s tišine → kraj
        }
        if (mediaRecorderRef.current.state === 'recording') requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch {
      /* bez detekcije — oslanjamo se na timere */
    }

    setListening(true);
    mr.start();
    // Ako se govor ne pojavi u ~6 s, prekini ciklus (efekt pokreće novi).
    idleTimerRef.current = setTimeout(stopIfRecording, 6000);
    // Gornja granica trajanja jedne snimke.
    maxTimerRef.current = setTimeout(stopIfRecording, 15000);
  }, [cleanupRecording]);

  // Jedinstveni pokretač "slušanja": Web Speech ako je dostupan, inače snimanje.
  const startCapture = useCallback(() => {
    if (useRecorderRef.current) void startRecordingCycle();
    else startListening();
  }, [startListening, startRecordingCycle]);

  // U glasovnom razgovoru slušanje je KONTINUIRANO, ALI pauzira dok bot GOVORI
  // (da mikrofon ne čuje sam sebe). Kad ne slušamo i bot ne govori, ponovno
  // pokreni slušanje. Stop gasi cijeli mod.
  useEffect(() => {
    if (!voiceMode || busy || listening || speaking || recognitionRef.current || mediaRecorderRef.current) {
      return;
    }
    const t = window.setTimeout(() => {
      if (
        voiceModeRef.current &&
        !speakingRef.current &&
        !recognitionRef.current &&
        !mediaRecorderRef.current
      ) {
        startCapture();
      }
    }, 500);
    return () => window.clearTimeout(t);
  }, [voiceMode, busy, listening, speaking, startCapture]);

  // Kad odgovor završi (busy → false): pošalji pitanje iz reda (izgovoreno usred
  // odgovora), inače pročitaj zadnji odgovor naglas (samo tekst, bez izvora).
  useEffect(() => {
    if (busy || !voiceMode) return;
    if (pendingRef.current) {
      const q = pendingRef.current;
      pendingRef.current = '';
      void sendRef.current(q);
      return;
    }
    const list = messagesRef.current;
    const last = list[list.length - 1];
    if (last && last.role === 'assistant' && last.content && lastSpokenRef.current !== last.content) {
      lastSpokenRef.current = last.content;
      speak(last.content);
    }
  }, [busy, voiceMode, speak]);

  const startVoiceMode = () => {
    if (busy) return;
    // KLJUČNO: "otključaj" izgovor unutar korisničkog klika — inače preglednici
    // (osobito mobilni) blokiraju kasniji programski speechSynthesis.speak().
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      try {
        const s = window.speechSynthesis;
        s.cancel();
        s.resume();
        const warm = new SpeechSynthesisUtterance(' ');
        warm.volume = 0;
        s.speak(warm);
        // osvježi listu glasova (ponekad je dostupna tek nakon interakcije)
        ttsVoiceRef.current = chooseVoice(s.getVoices());
      } catch {
        /* ignoriraj */
      }
    }
    voiceModeRef.current = true;
    setVoiceMode(true);
    startCapture();
  };
  const stopVoiceMode = () => {
    voiceModeRef.current = false;
    pendingRef.current = '';
    setVoiceMode(false);
    setListening(false);
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    try {
      mediaRecorderRef.current?.stop();
    } catch {
      /* ignoriraj */
    }
    cleanupRecording();
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
    if (ttsKeepAliveRef.current) {
      clearInterval(ttsKeepAliveRef.current);
      ttsKeepAliveRef.current = null;
    }
    speakingRef.current = false;
    setSpeaking(false);
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
