# Valpovački AI gradski informator — tehnički prijedlog

RAG (Retrieval-Augmented Generation) chatbot na hrvatskom jeziku (formalan stil) koji
odgovara na pitanja građana Grada Valpova i pripadajućih naselja na temelju javno
dostupnih web dokumenata gradske uprave i povezanih ustanova.

Cjelokupni izvorni kod nalazi se u ovom repozitoriju; ovaj dokument daje arhitekturu,
shemu, konfiguraciju, primjere i upute za rad. Upute za postavljanje korak-po-korak:
[../README.md](../README.md).

---

## 1. Sažetak i dizajnersko obrazloženje

**Zašto Claude (Messages API)?** Claude je među najjačim modelima za hrvatski jezik i
za vjerno pridržavanje sistemskih uputa (formalan ton, obavezno citiranje, odbijanje
izvan-domenskih pitanja, zabrana izmišljanja). Messages API podržava streaming (SSE),
što daje odziv "od prve riječi" i kvalitetan UX na sporijim vezama.

> **Dvije nužne korekcije izvorne specifikacije:**
> 1. Model **`claude-3.5-sonnet`** (puni ID `claude-3-5-sonnet-20241022`) **povučen je
>    iz upotrebe 28. 10. 2025.** i API za njega vraća 404. Zadani model stoga je
>    službena zamjena **`claude-sonnet-4-6`** — i dalje promjenjiv kroz `CLAUDE_MODEL`
>    (npr. `claude-haiku-4-5` za nižu cijenu/latenciju, `claude-opus-4-8` za najvišu
>    kvalitetu).
> 2. **Anthropic ne nudi API za embeddinge** — model "claude-embed-v1" ne postoji.
>    Zadani pružatelj embeddinga je **OpenAI `text-embedding-3-small` (1536 dim)**;
>    alternativno **Voyage AI `voyage-3` (1024 dim)** — pružatelj kojeg Anthropic
>    službeno preporučuje. Odabir i dimenzija parametrizirani su kroz
>    `EMBEDDING_PROVIDER` / `EMBEDDING_MODEL` / `EMBEDDING_DIM`.

**Zašto Supabase (Postgres + pgvector)?** Jedna baza pokriva sve: vektorsko
pretraživanje (pgvector, HNSW indeks), leksički rezervni kanal (Postgres FTS, GIN),
relacijske tablice dokumenata i anonimizirane logove razgovora — bez dodatne vektorske
infrastrukture. Besplatni/niski cjenovni razredi pokrivaju korpus gradske uprave
(tisuće dokumenata) s velikom rezervom.

**Zašto Vercel (Next.js 14, App Router)?** Frontend, API rute sa streamingom i
zakazana ingestija (Vercel Cron, subota 02:00) žive u istom deployu; git-push deploy s
GitHuba bez vlastite poslužiteljske infrastrukture. Trošak miruje kad nema prometa.

**Skalabilnost / trošak / održavanje:** sustav je serverless na svim razinama; jedina
"stalna" komponenta je Supabase Postgres. Tjedna inkrementalna ingestija vektorizira
samo promijenjene dokumente (usporedba `content_hash`), pa su troškovi embeddinga
nakon početnog indeksiranja zanemarivi. Svi RAG parametri (top-K, prag, proračun
konteksta, model) mijenjaju se ENV varijablama bez izmjene koda.

---

## 2. Arhitektura sustava

```
                      SUBOTA 02:00 UTC (Vercel Cron)            GRAĐANIN
                                 │                                  │
                                 ▼                                  ▼
┌──────────────────────────────────────────────┐   ┌─────────────────────────────┐
│  /api/ingest  (Node runtime, maxDuration 300)│   │  Web UI  /  embed widget    │
│  1. sitemap + seed URL-ovi (ALLOWED_HOSTS)   │   │  (Next.js, /  i  /widget)   │
│  2. robots.txt + rate-limit downloader       │   └──────────────┬──────────────┘
│  3. ekstrakcija: Cheerio (HTML), pdf-parse   │                  │ POST {messages}
│  4. content_hash → preskoči nepromijenjeno   │                  ▼
│  5. chunking (~1200 znakova, preklop ~200)   │   ┌─────────────────────────────┐
│  6. embedding (OpenAI / Voyage)              │   │  /api/chat (Node, SSE)      │
│  7. transakcijski upsert (RPC)               │   │  1. validacija + rate-limit │
└──────────────────┬───────────────────────────┘   │  2. embedding upita         │
                   │ upsert_document_with_chunks   │  3. retrieve():             │
                   ▼                               │     pgvector top-K          │
┌──────────────────────────────────────────────┐   │     (+ FTS rezerva)         │
│              SUPABASE (Postgres)             │◄──┤  4. sastavi prompt (HR)     │
│  dokumenti ─< dijelovi ─ ugradnje            │   │  5. Claude Messages API     │
│  (FTS GIN)     (pgvector HNSW)               │   │     — streaming             │
│  conversation_logs (anonimizirano)           │──►│  6. SSE: delta + citati     │
└──────────────────────────────────────────────┘   │  7. log u conversation_logs│
                                                   └──────────────┬──────────────┘
                       ┌─────────────────────────┐                │ SSE stream
                       │  Anthropic Claude API   │◄───────────────┘
                       │  (CLAUDE_MODEL)         │
                       └─────────────────────────┘
```

**Komponente**

| Komponenta | Implementacija | Opis |
|---|---|---|
| Ingestija (crawler/ETL) | `lib/ingest/*`, `scripts/ingest.ts`, `app/api/ingest/route.ts` | Sitemap/seed prikupljanje, robots.txt, rate-limit, ekstrakcija (HTML/PDF), čišćenje, deduplikacija hashom, chunking, embedding, transakcijski upsert |
| Vektorska baza | `supabase/schema.sql` | pgvector `vector(DIM)` + HNSW (cosine); FTS `tsvector` + GIN |
| Retriever | `lib/retrieval.ts` | RPC `match_chunks` (top-K, prag) + rezervni `search_chunks_fts`; deduplikacija, filtar domena, token-budžet |
| RAG orkestracija | `app/api/chat/route.ts` | Validacija → retrieval → prompt → Claude streaming → citati |
| Citati | `lib/prompt.ts`, `lib/retrieval.ts` | Format `[Naziv](URL) — provjereno: DD.MM.GGGG.` (datum iz `dokumenti.fetched_at`) |
| Logiranje/praćenje | `conversation_logs` + Vercel logs | Pitanje, odgovor, izvori, trajanje, model, ocjena; bez PII |
| Sigurnost | CSP, RLS, tajne, rate-limit | Vidi odjeljak 11 |

---

## 3. Shema baze i indeksi

Cjelovita shema: [`supabase/schema.sql`](../supabase/schema.sql). Sažetak:

* **`dokumenti`** — `id, url (unique), title, source, lang, municipality, content_raw,
  content_text, content_hash, published_at, fetched_at, updated_at`
* **`dijelovi`** — `id, document_id (FK, cascade), chunk_index, text, tokens_est` +
  **generirani `fts tsvector`** stupac (`to_tsvector('simple', unaccent(lower(text)))`
  — PostgreSQL nema konfiguraciju za hrvatski, pa se koristi `simple` + `unaccent`,
  što je za rezervni leksički kanal dovoljno)
* **`ugradnje`** — `chunk_id (PK/FK), ugradnja vector(1536), norm real, created_at`
* **`conversation_logs`** — pitanje, odgovor, izvori (jsonb), trajanje, model, ocjena,
  anonimizirani `user_hash`

**Indeksi**

```sql
-- vektorski (kosinusna udaljenost); HNSW: bolji recall, bez "trening" koraka
create index ugradnje_hnsw_idx on ugradnje using hnsw (ugradnja vector_cosine_ops);
-- alternativa za vrlo velike korpuse:
-- create index on ugradnje using ivfflat (ugradnja vector_cosine_ops) with (lists = 100);

-- leksički
create index dijelovi_fts_idx on dijelovi using gin (fts);
```

> **DIM:** stupci `vector(1536)` (tablica `ugradnje` i parametar `match_chunks`)
> moraju odgovarati `EMBEDDING_DIM`. Za `voyage-3` zamijenite s `vector(1024)`,
> za `text-embedding-3-large` s `vector(3072)`, zatim ponovno pokrenite ingestiju.

**RPC funkcije:** `match_chunks` (vektorsko top-K + prag), `search_chunks_fts`
(leksička rezerva), `upsert_document_with_chunks` (atomarni upsert dokumenta +
isječaka + vektora u jednoj transakciji), `touch_document` (osvježenje `fetched_at`
za nepromijenjene dokumente).

---

## 4. Konfiguracija i ENV varijable

Cjeloviti predložak s komentarima: [`.env.example`](../.env.example).

| Varijabla | Zadano | Opis |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Claude API ključ (obavezno) |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Model za generiranje (zamjena za povučeni claude-3.5-sonnet; promjenjivo) |
| `CLAUDE_MAX_TOKENS` | `1024` | Maksimalni izlazni tokeni po odgovoru |
| `EMBEDDING_PROVIDER` | `openai` | `openai` ili `voyage` (Anthropic nema embedding API) |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Model embeddinga |
| `EMBEDDING_DIM` | `1536` | **Mora odgovarati `vector(DIM)` u shemi!** |
| `OPENAI_API_KEY` / `VOYAGE_API_KEY` | — | Ključ odabranog pružatelja |
| `SUPABASE_URL` | — | URL Supabase projekta |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Service-role ključ (samo poslužitelj!) |
| `SUPABASE_ANON_KEY` | — | Anon ključ (rezerviran; klijent ne pristupa bazi izravno) |
| `RAG_TOP_K` | `8` | Broj isječaka iz vektorskog pretraživanja |
| `RAG_SCORE_THRESHOLD` | `0.35` | Prag kosinusne sličnosti (0–1) |
| `RAG_FTS_FALLBACK` | `1` | Leksička rezerva uklj./isklj. |
| `RAG_CONTEXT_CHAR_BUDGET` | `12000` | Proračun znakova konteksta (~3000 tokena) |
| `VERCEL_CRON_SECRET` | — | Tajna za autorizaciju `/api/ingest` |
| `ALLOWED_HOSTS` | `valpovo.hr,www.valpovo.hr,…` | Dopuštene domene izvora (crawler i citati) |
| `SITEMAP_URLS` / `SEED_URLS` | — | Početne točke indeksiranja |
| `MAX_CHUNK_TOKENS` | `300` | Cilj veličine isječka (~1200 znakova) |
| `CHUNK_OVERLAP` | `50` | Preklapanje isječaka (~200 znakova) |
| `CRAWL_DELAY_MS` | `1000` | Stanka između dohvaćanja URL-ova |
| `INGEST_MAX_URLS` | `200` | Maksimum URL-ova po pokretanju ingestije |
| `LANG` | `hr` | Jezik sadržaja |

---

## 5. Ingestija i obrada podataka

Implementacija: `lib/ingest/{crawler,robots,extract,pipeline}.ts`.

1. **Prikupljanje URL-ova** — `SITEMAP_URLS` (uklj. sitemap-indekse, rekurzivno) +
   `SEED_URLS`; svaki URL strogo filtriran po `ALLOWED_HOSTS`.
2. **Downloader** — poštuje `robots.txt` (Disallow za `User-agent: *` i vlastiti
   agent `ValpovoAIInformator`), identificira se vlastitim User-Agentom, stanka
   `CRAWL_DELAY_MS` između zahtjeva, timeout 30 s.
3. **Ekstrakcija** — HTML: Cheerio uz uklanjanje boilerplatea (navigacija, podnožja,
   cookie banneri, skripte); PDF: pdf-parse. Unicode NFC normalizacija, čišćenje
   razmaka.
4. **Inkrementalnost** — SHA-256 očišćenog teksta uspoređuje se s pohranjenim
   `content_hash`; nepromijenjeni dokumenti samo dobiju svjež `fetched_at`
   (RPC `touch_document`) — bez ponovne vektorizacije.
5. **Chunking** — po naslovima/odlomcima, cilj `MAX_CHUNK_TOKENS` (~1200 znakova) s
   preklapanjem `CHUNK_OVERLAP` (~200 znakova); predugi odlomci režu se po rečenicama.
6. **Embedding + upsert** — serije do 64 teksta po API pozivu; atomarni upsert kroz
   RPC `upsert_document_with_chunks` (dokument + isječci + vektori u jednoj
   transakciji).
7. **Logiranje i metrike** — broj novih / ažuriranih / nepromijenjenih / neuspjelih
   dokumenata i popis promašenih URL-ova; vidljivo u Vercel logsima i u odgovoru
   `/api/ingest`.

**Pokretanje:** lokalno `npm run ingest`; produkcijski automatski (Vercel Cron,
subota 02:00 UTC — vidi odjeljak 9) ili ručno:

```bash
curl -X POST https://VAŠA-DOMENA.vercel.app/api/ingest -H "x-ingest-secret: $VERCEL_CRON_SECRET"
```

---

## 6. Retrieval i RAG orkestracija

`lib/retrieval.ts` — `retrieve(query, options)`:

1. embedding upita (isti pružatelj/model kao za dokumente),
2. RPC `match_chunks(query_embedding, RAG_TOP_K, RAG_SCORE_THRESHOLD)` —
   kosinusna sličnost preko HNSW indeksa,
3. ako vektorski kanal vrati manje od `topK/2` rezultata i `RAG_FTS_FALLBACK=1`,
   dopuna iz `search_chunks_fts` (FTS rezultatima se dodjeljuje konzervativan score
   kako vektorski pogoci ne bi izgubili prednost),
4. filtar domena u citatima (`ALLOWED_HOSTS` — sigurnosna mreža),
5. deduplikacija (najviše 2 isječka po URL-u) + rezanje na
   `RAG_CONTEXT_CHAR_BUDGET`.

Svaki isječak nosi `title`, `url`, `score` i `fetched_at` (datum zadnje provjere —
ulazi u citat). *Reranking:* trenutačna heuristika je score-sort + deduplikacija;
parametri su u ENV-u, a sučelje `retrieve()` omogućuje kasnije uključivanje
cross-encoder rerankera (npr. Voyage rerank-2 ili Cohere Rerank) bez promjene poziva.

**Sistemski prompt (HR, formalan)** — `lib/prompt.ts`, ključna pravila:
točni i sažeti odgovori isključivo za područje Grada Valpova i pripadajućih naselja;
odgovaranje **samo** iz priloženih izvora; obavezni citati
`[Naziv](URL) — provjereno: DD.MM.GGGG.`; kada podatka nema — eksplicitno priznanje i
upućivanje na službene kanale; ljubazno odbijanje izvan-domenskih pitanja; bez
obrade osobnih podataka.

Kontekst se modelu predaje u zadnjoj korisničkoj poruci u XML obliku:

```
<izvori>
  <izvor id="1" naziv="…" url="…" provjereno="07.06.2026.">…tekst isječka…</izvor>
  …
</izvori>

Pitanje građanina: …
```

---

## 7. API za chat

`POST /api/chat` (`app/api/chat/route.ts`, Node runtime, SSE streaming):

* **Zahtjev:** `{ "messages": [{ "role": "user"|"assistant", "content": "…" }] }`
  (povijest + zadnje pitanje; pitanje ≤ 2000 znakova, zadržava se zadnjih 6 izmjena).
* **Tijek:** validacija → rate-limit (20 zahtjeva/min po IP-u, u memoriji instance;
  za strožu zaštitu preporučen Vercel WAF ili Upstash Ratelimit) → embedding upita →
  `retrieve()` → poruke za Claude → `anthropic.messages.stream()` → SSE.
* **SSE događaji:**
  `{"type":"delta","text":"…"}` (tekst), zatim
  `{"type":"sources","sources":[{title,url,score,fetched_at}]}` (citati, filtrirani
  na `ALLOWED_HOSTS`), te `{"type":"done"}`; pri grešci `{"type":"error","error":"…"}`.
* **Obrada grešaka:** tipizirane iznimke SDK-a (`RateLimitError`, `OverloadedError` →
  503 s porukom na hrvatskom); greške tijekom streama šalju se kao SSE `error` događaj.
* Nakon završetka stream-a zapis se (fire-and-forget) sprema u `conversation_logs`.

`POST /api/feedback` — ocjena korisnika 1–5 za zadnji odgovor (odjeljak 10).

---

## 8. Minimalni frontend i embed widget

* **`/`** (`app/page.tsx` + `components/Chat.tsx`) — jednostavna chat stranica na
  hrvatskom: streaming prikaz odgovora, citati s datumom provjere ispod odgovora,
  transparentan disclaimer (AI generirani odgovori; ne unositi osobne podatke).
* **`/widget`** — kompaktna inačica za iframe; CSP `frame-ancestors` ograničava
  ugradnju na `valpovo.hr` (podesivo u `next.config.mjs`).
* **`public/widget.js`** — plutajući gumb + iframe; ugradnja na gradsko web sjedište
  jednim retkom prije `</body>`:

```html
<script src="https://VAŠA-DOMENA.vercel.app/widget.js" defer></script>
```

---

## 9. CI/CD i deployment

**Supabase:** novi projekt → SQL Editor → izvršiti `supabase/schema.sql` (uključuje
`create extension vector`). Prije izvršavanja uskladiti `vector(DIM)` s odabranim
modelom embeddinga.

**Vercel:** import GitHub repozitorija → unijeti ENV varijable (odjeljak 4) →
deploy. `vercel.json` definira cron:

```json
{ "crons": [{ "path": "/api/ingest", "schedule": "0 2 * * 6" }] }
```

* Raspored je **subota 02:00 UTC** (04:00 ljetnog hrvatskog vremena). Cron pozive
  autorizira `VERCEL_CRON_SECRET`.
* `/api/chat` i `/api/ingest` su **Node runtime** (Supabase JS i pdf-parse); chat
  ruta streama odgovore pa dugotrajne veze nisu problem. `maxDuration`: chat 60 s,
  ingest 300 s (Vercel Pro; na Hobby planu smanjiti na 60 i osloniti se na
  inkrementalnost kroz više pokretanja).

**GitHub Actions** (`.github/workflows/ci.yml`): `npm ci` → type-check → lint →
build; opcionalni smoke test API-ja nakon deploya. (U monorepu kopirati workflow u
korijen repozitorija i postaviti `working-directory`.)

---

## 10. Evaluacija i nadzor kvalitete

* **`conversation_logs`** — pitanje, odgovor, izvori (jsonb), trajanje, model,
  korisnikova ocjena (1–5 preko `/api/feedback`), anonimizirani `user_hash`.
  Pregled npr.: prosječna ocjena po tjednu, najčešća pitanja bez izvora
  (kandidati za dopunu sadržaja na webu!).
* **Offline evaluacija** — `npm run eval` nad `scripts/eval-set.json`
  (testni upiti + referentni URL-ovi). Metrike: **hit@k** (je li referentni URL među
  citatima) i **preciznost citata** (udio citiranih izvora koji su relevantni).
  Skup proširivati stvarnim pitanjima iz `conversation_logs`.

---

## 11. Sigurnost i privatnost

* **Bez PII:** chatbot ne traži ni ne pohranjuje osobne podatke; logovi su
  anonimizirani (IP se ne sprema — samo skraćeni slani hash); UI sadrži disclaimer
  i molbu da se osobni podaci ne unose. Sistemski prompt nalaže da se eventualno
  podijeljeni osobni podaci ne ponavljaju u odgovoru.
* **Izvori:** crawler i citati strogo ograničeni na `ALLOWED_HOSTS`; poštuje se
  robots.txt; rate-limit prema izvorima.
* **Tajne:** svi ključevi isključivo u ENV varijablama na poslužitelju;
  `SUPABASE_SERVICE_ROLE_KEY` nikad ne napušta server; RLS uključen na svim
  tablicama (anon klijent nema pristup).
* **Otpornost:** timeouts na svim vanjskim pozivima (10–30 s); SDK-ovi imaju ugrađene
  retrije s backoffom (Anthropic SDK: automatski retry 429/5xx); ingestija ima
  vlastiti deadline i nastavlja idući put.
* **Zlouporaba:** rate-limit na `/api/chat` (20/min po IP-u); ograničenje duljine
  pitanja; `/api/ingest` zaštićen tajnom; CSP `frame-ancestors` na widgetu.

---

## 12. Primjeri

**Primjer 1 — upit s dostupnim odgovorom**

> **Građanin:** Koje je radno vrijeme gradske uprave?
>
> **Informator:** Gradska uprava Grada Valpova radi ponedjeljkom do petkom od 7:00 do
> 15:00 sati, a rad sa strankama organiziran je od 8:00 do 14:00 sati. Za dolazak
> izvan tog vremena preporučujemo prethodnu najavu telefonom na 031/656-200.
>
> Izvori: [Kontakt — Grad Valpovo](https://valpovo.hr/kontakt/) — provjereno: 07.06.2026.

**Primjer 2 — podatak nije u korpusu**

> **Građanin:** Koliko će iznositi komunalna naknada 2027. godine?
>
> **Informator:** Nažalost, trenutačno ne raspolažem ažurnim podatkom o iznosu
> komunalne naknade za 2027. godinu. Preporučujemo da se obratite Gradu Valpovu putem
> službenih stranica (https://valpovo.hr) ili telefonom na 031/656-200.

**Primjer 3 — izvan domene**

> **Građanin:** Napiši mi recept za sarmu.
>
> **Informator:** Hvala na upitu! Ja sam informativni asistent Grada Valpova te mogu
> odgovarati isključivo na pitanja o gradskoj upravi, uslugama, ustanovama i
> događanjima u Valpovu i pripadajućim naseljima. Slobodno mi postavite pitanje iz
> tog područja.

**Sistemski prompt i predložak poruka:** vidi [`lib/prompt.ts`](../lib/prompt.ts)
(konstanta `SYSTEM_PROMPT_HR` i funkcija `buildUserPrompt` — format `<izvori>` bloka
prikazan u odjeljku 6).

---

## 13. Stablo direktorija

```
valpovo-ai-informator/
├── README.md                     # upute: postavljanje, deploy, održavanje
├── docs/TEHNICKI-PRIJEDLOG.md    # ovaj dokument
├── package.json                  # ovisnosti i skripte
├── tsconfig.json
├── next.config.mjs               # pdf-parse external, CSP za /widget
├── vercel.json                   # CRON: subota 02:00 UTC → /api/ingest
├── .env.example                  # sve ENV varijable s objašnjenjima
├── .github/workflows/ci.yml      # lint, type-check, build (+ smoke test)
├── supabase/schema.sql           # ekstenzije, tablice, indeksi, RPC funkcije
├── lib/
│   ├── config.ts                 # čitanje/validacija ENV varijabli
│   ├── supabase.ts               # service-role klijent (samo poslužitelj)
│   ├── embeddings.ts             # apstrakcija: OpenAI / Voyage + provjera DIM
│   ├── chunking.ts               # normalizacija i dijeljenje teksta
│   ├── retrieval.ts              # pgvector + FTS rezerva, deduplikacija, budžet
│   ├── prompt.ts                 # sistemski prompt (HR) + predložak poruka
│   └── ingest/
│       ├── crawler.ts            # sitemap/seed, ALLOWED_HOSTS, downloader
│       ├── robots.ts             # poštivanje robots.txt
│       ├── extract.ts            # Cheerio (HTML) + pdf-parse (PDF), čišćenje
│       └── pipeline.ts           # cijeli ingest cjevovod + statistika
├── scripts/
│   ├── ingest.ts                 # lokalno pokretanje ingestije (npm run ingest)
│   ├── eval.ts                   # offline evaluacija: hit@k, preciznost citata
│   └── eval-set.json             # testni upiti + referentni URL-ovi
├── app/
│   ├── layout.tsx  /  globals.css
│   ├── page.tsx                  # minimalni chat UI (HR, formalan stil)
│   ├── widget/page.tsx           # kompaktni chat za iframe ugradnju
│   └── api/
│       ├── chat/route.ts         # RAG + Claude streaming (SSE)
│       ├── ingest/route.ts       # cron/ručna ingestija (autorizirano tajnom)
│       └── feedback/route.ts     # ocjena korisnika (1–5)
├── components/Chat.tsx           # zajednička chat komponenta (stream + citati)
├── public/widget.js              # embed skripta (gumb + iframe)
└── types/pdf-parse.d.ts
```
