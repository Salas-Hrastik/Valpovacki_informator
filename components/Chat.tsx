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
// što može pitati. Klik šalje pitanje izravno. Zadržavamo samo tri pitanja
// najopćenitijeg karaktera da sučelje ostane pregledno.
const PRIJEDLOZI = [
  'Koje je radno vrijeme gradske uprave?',
  'Koji su aktualni natječaji i javni pozivi?',
  'Koji su kontakti gradske uprave?',
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


/** Poveznice koje se ne mogu prikazati u skočnom pregledniku (odbijaju ugradnju u okvir). */
const NO_EMBED =
  /^https?:\/\/((www\.|maps\.)?google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps|([a-z0-9-]+\.)?(facebook|instagram|youtube|tiktok|x|twitter|linkedin)\.com|youtu\.be)/i;

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  // Indeks poruke čiji je skočni prozor s izvorima trenutačno otvoren (ili null).
  const [sourcesIdx, setSourcesIdx] = useState<number | null>(null);
  // URL poveznice koja se prikazuje u skočnom pregledniku (ili null kad je zatvoren).
  const [linkPreview, setLinkPreview] = useState<string | null>(null);
  // Glasovni unos (Web Speech API): podržanost, je li snimanje u tijeku te
  // "glasovni razgovor" (hands-free: nakon stanke se pitanje šalje samo, a nakon
  // odgovora se ponovno sluša — dok korisnik ne zaustavi).
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [useRecorder, setUseRecorder] = useState(false); // iOS: snimanje umjesto Web Speech
  const [voiceErr, setVoiceErr] = useState(''); // vidljiva poruka kad glas ne radi
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceModeRef = useRef(false);
  const transcriptRef = useRef('');
  const busyRef = useRef(false);
  const pendingRef = useRef('');
  const messagesRef = useRef<Message[]>([]);
  // Fallback glasovni unos SNIMANJEM (za uređaje bez Web Speech API-ja, npr. iPhone):
  // snimi zvuk pa pošalji /api/transcribe (Whisper). useRecorderRef = koristi se taj put.
  const useRecorderRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vadIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null); // iOS: praćenje glasnoće radi auto-stopa
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speechEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref na startRecordingCycle — dostupan unutar startListening onerror-a za fallback
  const startRecordingCycleRef = useRef<() => Promise<void>>(async () => {});
  // iOS: zastavica za slanje (continuous=false → restart loop; šaljemo tek kad finish() postavi ovu)
  const shouldSendRef = useRef(false);
  // iOS: transkript iz prethodnih ciklusa prepoznavanja (accumulate across restarts)
  const iosBaseRef = useRef('');

  // Provjera podrške za glasovni unos. Probamo Web Speech API na svim platformama
  // (uključujući iOS 16.4+ koji ga podržava s interim rezultatima); na grešci
  // automatski padamo na MediaRecorder + /api/transcribe.
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
    // Web Speech API ima prioritet na svim platformama (daje tekst u realnom
    // vremenu). Recorder je fallback kad Web Speech nije dostupan ili ne radi.
    const preferRecorder = recorder && !webSpeech;
    useRecorderRef.current = preferRecorder;
    setUseRecorder(preferRecorder);
    setVoiceSupported(preferRecorder || webSpeech);
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

  // Zatvaranje skočnog preglednika poveznice tipkom Esc.
  useEffect(() => {
    if (linkPreview === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLinkPreview(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [linkPreview]);

  // Otvara poveznicu (izvor ili poveznicu u odgovoru) u skočnom pregledniku
  // umjesto u novoj kartici. Vraća handler za onClick koji spriječi zadanu navigaciju.
  const openLink = (url?: string) => (e: React.MouseEvent) => {
    if (!url) return;
    // Stranice koje sigurno odbijaju ugradnju (Google karte, društvene mreže) idu
    // izravno u novu karticu — <a target="_blank"> to radi sam.
    if (NO_EMBED.test(url)) return;
    e.preventDefault();
    setLinkPreview(url);
  };

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
    setListening(false);
    recognitionRef.current?.stop();
    try {
      mediaRecorderRef.current?.stop();
    } catch {
      /* ignoriraj */
    }
    cleanupRecording();
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

  // Pokreni jedan ciklus slušanja. iOS ne podržava continuous=true pa koristimo
  // restart petlju: nakon svakog onend nastavljamo slušati dok finish() ne postavi
  // shouldSendRef (2,5 s tišine) ili korisnik ne pritisne "Gotovo".
  const startListening = useCallback((isRestart = false) => {
    if (recognitionRef.current) return;
    const w = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return;
    // Na svježem startu resetiramo transkript i iOS akumulirani tekst;
    // na iOS restartu čuvamo akumulirani tekst u iosBaseRef.
    if (!isRestart) {
      transcriptRef.current = '';
      iosBaseRef.current = '';
    }
    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const rec = new Ctor();
    rec.lang = 'hr-HR';
    rec.interimResults = true;
    // iOS ne podržava continuous=true (odmah abortira ili ignorira govor);
    // koristimo false + restart petlju u onend.
    rec.continuous = !isIOS;
    const clearWsTimers = () => {
      for (const r of [speechEndTimerRef, idleTimerRef]) {
        if (r.current) {
          clearTimeout(r.current);
          r.current = null;
        }
      }
    };
    const finish = () => {
      clearWsTimers();
      shouldSendRef.current = true; // signalizira onend-u da pošalje
      try {
        // Zaustavlja TRENUTNO aktivno prepoznavanje — može biti kasniji iOS
        // restart ciklus, pa ne koristimo zatvoreni rec nego recognitionRef.
        recognitionRef.current?.stop();
      } catch {
        /* ignoriraj */
      }
    };
    rec.onresult = (event) => {
      let sessionText = '';
      for (let i = 0; i < event.results.length; i++) sessionText += event.results[i][0].transcript;
      // iOS (continuous=false): svaki ciklus daje rezultate samo za tu sesiju;
      // akumuliramo s prethodnim ciklusima pohranjenim u iosBaseRef.
      const text = isIOS && iosBaseRef.current
        ? iosBaseRef.current + ' ' + sessionText
        : sessionText;
      transcriptRef.current = text;
      setInput(text);
      if (taRef.current) autoGrow(taRef.current);
      // Čuo se govor: makni "nema govora" timer i resetiraj ZAVRŠNU tišinu (~2,5 s)
      // — tek nakon te tišine smatramo pitanje dovršenim i šaljemo ga.
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      if (speechEndTimerRef.current) clearTimeout(speechEndTimerRef.current);
      speechEndTimerRef.current = setTimeout(finish, 2500);
    };
    rec.onend = () => {
      recognitionRef.current = null;
      const wasActive = voiceModeRef.current;
      // iOS restart petlja: continuous=false → recognition staje nakon svakog iskaza;
      // ako finish() još nije postavio zastavicu, nastavljamo slušati.
      if (isIOS && wasActive && !shouldSendRef.current) {
        iosBaseRef.current = transcriptRef.current; // sačuvaj dosad prepoznato
        // Ako timer teče (nešto je prepoznato), produžimo mu rok: novi ciklus
        // treba 500–2000 ms da se inicijalizira i stigne do onresult.
        // onresult u novom ciklusu će resetirati na 2500 ms od tada.
        // Ako timer ne teče (korisnik još nije ništa rekao), ne diramo ništa.
        if (speechEndTimerRef.current) {
          clearTimeout(speechEndTimerRef.current);
          speechEndTimerRef.current = setTimeout(finish, 4000);
        }
        setTimeout(() => { if (voiceModeRef.current) startListening(true); }, 80);
        return;
      }
      clearWsTimers();
      setListening(false);
      shouldSendRef.current = false;
      voiceModeRef.current = false;
      setVoiceMode(false);
      if (!wasActive) return;
      const text = transcriptRef.current.trim();
      if (text) {
        setInput('');
        resetInputHeight();
        if (busyRef.current) pendingRef.current = text; // odgovor još traje — pošalji čim završi
        else void sendRef.current(text); // auto-slanje nakon stanke (pismeni odgovor)
      }
    };
    rec.onerror = (event) => {
      clearWsTimers();
      recognitionRef.current = null;
      setListening(false);
      const err = event?.error ?? 'unknown';
      // Fatalne greške (nema dopuštenja/mikrofona) — ugasi mod.
      if (err === 'not-allowed' || err === 'audio-capture') {
        voiceModeRef.current = false;
        setVoiceMode(false);
        setVoiceErr('Mikrofon nije dopušten. Molite odobrite pristup mikrofonu u postavkama preglednika.');
        return;
      }
      // Web Speech service nedostupan (network/service greška) → automatski
      // padi na MediaRecorder + Whisper ako je dostupan (npr. stariji iOS).
      if (err === 'network' || err === 'service-not-allowed' || err === 'language-not-supported') {
        const hasRecorder =
          typeof MediaRecorder !== 'undefined' &&
          !!navigator.mediaDevices?.getUserMedia;
        if (hasRecorder && voiceModeRef.current) {
          useRecorderRef.current = true;
          setUseRecorder(true);
          setVoiceErr(`Web Speech greška (${err}) — prebačeno na snimanje.`);
          void startRecordingCycleRef.current();
          return;
        }
        voiceModeRef.current = false;
        setVoiceMode(false);
        setVoiceErr(`Web Speech nedostupan (${err}). Molite osvježite stranicu.`);
        return;
      }
      // 'no-speech'/'aborted' — ponovo pokrenemo ako smo još u modu diktata
      if (voiceModeRef.current) {
        setTimeout(() => { if (voiceModeRef.current) startListening(true); }, 150);
      } else {
        voiceModeRef.current = false;
        setVoiceMode(false);
      }
    };
    recognitionRef.current = rec;
    setListening(true);
    try {
      rec.start();
      // Uvijek 8 s idle fallback — speechEndTimerRef (2,5 s od zadnjeg govora)
      // je pravi mehanizam za detekciju kraja govora; idleMs je samo rezerva
      // za slučaj da korisnik uopće ne govori u novoj sesiji.
      const idleMs = 8000;
      idleTimerRef.current = setTimeout(finish, idleMs);
    } catch (e) {
      recognitionRef.current = null;
      setListening(false);
      voiceModeRef.current = false;
      setVoiceMode(false);
      setVoiceErr(`Greška pokretanja prepoznavanja govora: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  // Počisti resurse snimanja (timeri, audio kontekst, mikrofonski tokovi).
  const cleanupRecording = useCallback(() => {
    for (const ref of [silenceTimerRef, idleTimerRef, maxTimerRef, speechEndTimerRef]) {
      if (ref.current) {
        clearTimeout(ref.current);
        ref.current = null;
      }
    }
    if (vadIntervalRef.current) {
      clearInterval(vadIntervalRef.current);
      vadIntervalRef.current = null;
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

  // Fallback unos SNIMANJEM (stariji iOS / uređaji bez Web Speech): snimi zvuk,
  // automatski stani nakon kratke tišine, pošalji /api/transcribe (Whisper).
  const startRecordingCycle = useCallback(async () => {
    if (mediaRecorderRef.current) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      voiceModeRef.current = false; // dopuštenje odbijeno / nema mikrofona
      setVoiceMode(false);
      setListening(false);
      setVoiceErr('Nije moguće pristupiti mikrofonu. Dopustite pristup mikrofonu u postavkama preglednika.');
      return;
    }
    if (!voiceModeRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    mediaStreamRef.current = stream;
    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
      voiceModeRef.current = false;
      setVoiceMode(false);
      setListening(false);
      setVoiceErr('Snimanje zvuka nije podržano na ovom pregledniku.');
      return;
    }
    mediaRecorderRef.current = mr;
    const chunks: BlobPart[] = [];

    mr.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    mr.onstop = async () => {
      const blob = new Blob(chunks, { type: mr.mimeType || 'audio/mp4' });
      const wasActive = voiceModeRef.current;
      cleanupRecording();
      // Diktat je JEDAN KRUG — nakon snimke gasimo glasovni unos.
      voiceModeRef.current = false;
      setVoiceMode(false);
      if (!wasActive || blob.size < 1200) {
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
        if (!r.ok) {
          setVoiceErr('Prijepis govora trenutačno nije moguć. Pokušajte ponovno.');
        } else if (text) {
          setInput('');
          resetInputHeight();
          if (busyRef.current) pendingRef.current = text;
          else void sendRef.current(text);
        } else {
          setVoiceErr('Nisam razabrala govor. Pokušajte ponovno, bliže mikrofonu.');
        }
      } catch {
        setListening(false);
        setVoiceErr('Prijepis govora trenutačno nije moguć. Pokušajte ponovno.');
      }
    };

    setListening(true);
    try {
      mr.start();
    } catch {
      cleanupRecording();
      setListening(false);
      return;
    }

    // AUTO-STOP NA STANKU (diktat): pratimo glasnoću mikrofona; kad korisnik
    // prestane govoriti (~2 s tišine nakon što je nešto rekao), snimka se sama
    // zaustavlja i šalje na prijepis — bez potrebe za ručnim ⏹.
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        audioCtxRef.current = ctx;
        // iOS zna otvoriti kontekst "suspended" nakon await-a — pokušaj nastaviti
        // (inače analiza glasnoće ne dobiva podatke). Ručni ⏹ i maxTimer su rezerva.
        if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
        const sourceNode = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        sourceNode.connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        let spoke = false;
        const SILENCE_MS = 2000;
        vadIntervalRef.current = setInterval(() => {
          if (!mediaRecorderRef.current) return;
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);
          if (rms > 0.035) {
            // čuje se govor — poništi odbrojavanje tišine
            spoke = true;
            if (silenceTimerRef.current) {
              clearTimeout(silenceTimerRef.current);
              silenceTimerRef.current = null;
            }
          } else if (spoke && !silenceTimerRef.current) {
            // nastupila tišina nakon govora — zaustavi za SILENCE_MS
            silenceTimerRef.current = setTimeout(stopRecording, SILENCE_MS);
          }
        }, 150);
      }
    } catch {
      /* ako praćenje glasnoće ne radi, ostaje ručni ⏹ i sigurnosni maxTimer */
    }

    // Sigurnosna gornja granica (ako auto-stop omane): najduže ~25 s.
    maxTimerRef.current = setTimeout(() => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          /* ignoriraj */
        }
      }
    }, 25000);
  }, [cleanupRecording]);

  // Zaustavi trenutnu snimku i pošalji je na prijepis (gumb ⏹ na iOS-u).
  const stopRecording = () => {
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
    } catch {
      /* ignoriraj */
    }
  };

  // Drži ref ažurnim — startListening-ov onerror može pozvati fallback bez closure-problema
  useEffect(() => { startRecordingCycleRef.current = startRecordingCycle; }, [startRecordingCycle]);

  // Jedinstveni pokretač "slušanja": Web Speech ako je dostupan, inače snimanje.
  const startCapture = useCallback(() => {
    if (useRecorderRef.current) void startRecordingCycle();
    else startListening();
  }, [startListening, startRecordingCycle]);

  // Diktat je JEDAN KRUG (nema kontinuiranog "razgovora"): nakon stanke se
  // pitanje pošalje i glasovni se unos gasi. Ako je pitanje izgovoreno dok je
  // prethodni odgovor još tekao, pošalji ga čim odgovor završi.
  useEffect(() => {
    if (busy) return;
    if (pendingRef.current) {
      const q = pendingRef.current;
      pendingRef.current = '';
      void sendRef.current(q);
    }
  }, [busy]);

  const startVoiceMode = () => {
    if (busy) return;
    setVoiceErr('');
    voiceModeRef.current = true;
    setVoiceMode(true);
    shouldSendRef.current = false;
    iosBaseRef.current = '';
    transcriptRef.current = '';
    // Resetiraj Whisper-fallback zastavicu: prolazna Web Speech greška iz prethodne
    // sesije ne smije trajno zaključati app u Whisper mod. Ako Web Speech postoji,
    // pokušaj ga opet; onerror će opet prebaciti na Whisper ako zatreba.
    {
      const w = window as unknown as {
        SpeechRecognition?: unknown;
        webkitSpeechRecognition?: unknown;
      };
      if (w.SpeechRecognition || w.webkitSpeechRecognition) {
        useRecorderRef.current = false;
        setUseRecorder(false);
      }
    }
    startCapture();
    // Scroll input into view so interim transcript text is immediately visible
    setTimeout(() => taRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
  };
  // "Gotovo": zaustavi slušanje i POŠALJI prepoznato/snimljeno (voiceModeRef ostaje
  // uključen da onend/onstop obave slanje). Ako ništa nije rečeno, tiho završi.
  const finishVoice = () => {
    if (useRecorderRef.current) {
      stopRecording(); // → onstop: prijepis (Whisper) + slanje
    } else {
      shouldSendRef.current = true; // force-send na sljedećem onend (iOS restart petlja)
      try {
        recognitionRef.current?.stop(); // → onend: slanje prepoznatog teksta
      } catch {
        /* ignoriraj */
      }
    }
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
            {m.role === 'assistant' && (
              <span className="msg-avatar" aria-hidden="true" title="Marica">
                M
              </span>
            )}
            <div className="msg-bubble">
              {m.content ? (
                <div className="msg-text">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      // Poveznice se otvaraju u novoj kartici, sigurno (noopener).
                      a: ({ node, href, ...props }) => (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={openLink(href)}
                          {...props}
                        />
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
          <div className="chat-empty">
            <span className="chat-empty-avatar" aria-hidden="true">M</span>
            <p className="chat-empty-hint">
              Bok, ja sam <strong>Marica</strong>. Kako vam mogu pomoći? Odaberite pitanje ili
              upišite svoje.
            </p>
            <div className="chat-suggestions" aria-label="Prijedlozi pitanja">
              {PRIJEDLOZI.map((q) => (
                <button key={q} type="button" className="chip" onClick={() => void send(q)}>
                  {q}
                </button>
              ))}
            </div>
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
          className={listening ? 'dictating' : undefined}
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
          placeholder={
            voiceMode
              ? 'Govorite… sama ću stati nakon stanke'
              : listening
                ? 'Prepisujem govor…'
                : 'Postavite pitanje o Gradu Valpovu…'
          }
          maxLength={2000}
          disabled={busy}
          aria-label="Vaše pitanje"
        />
        {voiceSupported && !voiceMode && (
          // Diktat: jedan pritisak pokreće govorni unos; tekst se upisuje sam, a
          // nakon stanke se pitanje pošalje. Nema zasebnog "snimanja".
          <button
            type="button"
            className="chat-mic"
            onClick={startVoiceMode}
            disabled={busy || listening}
            aria-label="Izgovorite pitanje"
            title="Izgovorite pitanje"
          >
            🎤
          </button>
        )}
        {voiceSupported && voiceMode && (
          // Dok sluša: jasno "Gotovo" — zaustavi i pošalji odmah (inače stane sama).
          <button
            type="button"
            className="chat-mic listening"
            onClick={finishVoice}
            aria-pressed={true}
            aria-label="Gotovo — zaustavi i pošalji"
            title="Gotovo — zaustavi i pošalji"
          >
            ⏹
          </button>
        )}
        <button type="submit" disabled={busy || !input.trim()}>
          Pošalji
        </button>
      </form>

      {voiceErr && (
        <p className="voice-err" role="status">
          {voiceErr}
        </p>
      )}

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
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={openLink(s.url)}
                  >
                    {s.title}
                  </a>{' '}
                  <span className="msg-source-date">(provjereno: {formatDateHr(s.fetched_at)})</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {linkPreview !== null && (
        <div
          className="link-modal-backdrop"
          role="presentation"
          onClick={() => setLinkPreview(null)}
        >
          <div
            className="link-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Pregled poveznice"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="link-modal-head">
              <span className="link-modal-url" title={linkPreview}>
                {linkPreview}
              </span>
              <a
                className="link-modal-open"
                href={linkPreview}
                target="_blank"
                rel="noopener noreferrer"
              >
                Otvori u novoj kartici ↗
              </a>
              <button
                type="button"
                className="link-modal-close"
                onClick={() => setLinkPreview(null)}
                aria-label="Zatvori pregled"
              >
                ✕
              </button>
            </div>
            <div className="link-modal-hint">
              <span>
                Ne vidite stranicu ispod? Neke je stranice moguće otvoriti samo u novoj kartici.
              </span>
              <a
                className="link-modal-hint-btn"
                href={linkPreview}
                target="_blank"
                rel="noopener noreferrer"
              >
                Otvori u novoj kartici ↗
              </a>
            </div>
            <iframe
              className="link-modal-frame"
              src={linkPreview}
              title="Pregled poveznice"
              sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
              referrerPolicy="no-referrer"
            />
          </div>
        </div>
      )}
    </div>
  );
}
