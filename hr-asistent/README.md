# AI asistent ljudskih potencijala — „Petra"

Edukativni RAG chatbot na hrvatskom jeziku koji studentima, polaznicima i
praktičarima pomaže u učenju **menadžmenta ljudskih potencijala** — isključivo na
temelju knjige **Menadžment ljudskih potencijala**. Stack: **Next.js 14 (Vercel) +
Supabase (Postgres + pgvector) + Claude (Anthropic Messages API)**.

Samostalan projekt rađen po uzoru na edukativni asistent **Počela gastronomije**
(ista struktura elemenata): info-traka, naslov s dobrodošlicom, chat s prijedlozima
pitanja, citati izvora, glasovni unos, ocjena odgovora, embed widget.

➡️ Detaljan tehnički prijedlog (arhitektura, shema, dizajnerske odluke):
**[docs/TEHNICKI-PRIJEDLOG.md](docs/TEHNICKI-PRIJEDLOG.md)**

> **Dvije važne napomene o modelima:**
> * Zadani model za generiranje je `claude-sonnet-4-6` (promjenjivo kroz `CLAUDE_MODEL`).
> * Anthropic **ne nudi API za embeddinge**; zadano je OpenAI
>   `text-embedding-3-small` (1536 dim), alternativno Voyage AI `voyage-3`
>   (1024 dim). Dimenzija mora odgovarati `vector(DIM)` u `supabase/schema.sql`.

---

## Što asistentica zna (edukativne uloge)

* **Odgovori na pitanja** — isključivo iz knjige, s citatom poglavlja i stranica.
* **Objasni** — pojam jednostavnim riječima, s primjerom iz knjige.
* **Sažmi** — poglavlje/temu u pregledne natuknice.
* **Ispitaj me / kviz** — postavlja pitanja jedno po jedno i ocjenjuje odgovore prema knjizi.
* **Usporedi** — pojmove i metode (npr. metode selekcije) tablično.

## Postavljanje (korak po korak)

### 1. Supabase

1. Kreirajte projekt na [supabase.com](https://supabase.com) (regija: `eu-central-1`).
2. **SQL Editor** → zalijepite sadržaj [`supabase/schema.sql`](supabase/schema.sql) →
   **Run**. (Skripta uključuje `create extension vector` — pgvector.)
3. Ako mijenjate model embeddinga, prije izvršavanja uskladite sva pojavljivanja
   `vector(1536)` s dimenzijom vašeg modela (`EMBEDDING_DIM`).
4. Zabilježite **Project URL**, **service_role** i **anon** ključ
   (Project Settings → API).

### 2. Knjiga (korpus znanja)

Stavite knjigu u mapu [`knowledge/`](knowledge/README.md) — PDF s tekstualnim
slojem, Markdown ili čisti tekst. Skenirani PDF prije toga provucite kroz OCR
(npr. `ocrmypdf -l hrv`). Provjerite podjelu na poglavlja:

```bash
npm run ingest -- --dry-run
```

### 3. Lokalno pokretanje

```bash
cd hr-asistent
cp .env.example .env.local       # popunite vrijednosti (vidi komentare u datoteci)
npm install
npm run ingest                   # indeksiranje knjige
npm run dev                      # http://localhost:3000
```

### 4. Deploy na Vercel

1. Push projekta na GitHub (preporučeno kao zaseban repozitorij; u monorepu na
   Vercelu postavite **Root Directory** na `hr-asistent`).
2. [vercel.com/new](https://vercel.com/new) → import repozitorija (Next.js se
   detektira automatski).
3. **Settings → Environment Variables** → unesite sve varijable iz
   [`.env.example`](.env.example).
4. Deploy. Za razliku od web-informatora **nema crona** — knjiga se ne mijenja;
   nakon deploya s novom/izmijenjenom knjigom jednokratno pozovite `/api/ingest`
   (ili indeksirajte lokalno, korak 3).

### 5. Ugradnja widgeta na web sjedište

Jedan redak prije `</body>`:

```html
<script src="https://VAŠA-DOMENA.vercel.app/widget.js" defer></script>
```

Dopuštene roditeljske domene (CSP `frame-ancestors`) podešavaju se u
[`next.config.mjs`](next.config.mjs).

---

## Održavanje

| Zadatak | Kako |
|---|---|
| Ručno pokretanje ingestije | `curl -X POST https://DOMENA/api/ingest -H "x-ingest-secret: $INGEST_SECRET"` ili lokalno `npm run ingest` |
| Provjera podjele knjige | `npm run ingest -- --dry-run` (popis odjeljaka s rasponima stranica i veličinom; bez upisa u bazu) |
| Čišćenje nakon promjene strukture | `npm run ingest -- --prune` (obriše odjeljke kojih više nema u knjizi; cascade uklanja isječke i vektore) |
| Zamjena/dopuna knjige | Nova datoteka u `knowledge/` → `npm run ingest` (inkrementalno: nepromijenjeni odjeljci se preskaču) |
| Promjena modela | `CLAUDE_MODEL` u Vercel ENV (bez izmjene koda) |
| Promjena embeddinga | `EMBEDDING_*` ENV **+ uskladiti `vector(DIM)` u shemi + ponovna ingestija** |
| Nadzor kvalitete | Tablica `conversation_logs` (pitanja, izvori, trajanje, ocjene); `npm run eval` za offline metrike (hit@k, preciznost citata). Skup je u `scripts/eval-set.json`; referentne oznake izoštrite nakon prve ingestije |
| Dijagnostika dohvata | `npm run rag:debug -- "<pitanje>" --find=<dio-oznake>` |
| CI | `.github/workflows` u korijenu repozitorija — type-check, lint, build |

## API (sažetak)

* `POST /api/chat` — `{ messages: [{role, content}] }` → SSE stream
  (`delta` → `sources` → `done`).
* `POST /api/ingest` — pokretanje ingestije knjige (zaštićeno `INGEST_SECRET`).
* `POST /api/feedback` — `{ rating: 1–5 }` za zadnji odgovor.
* `POST /api/transcribe` — glasovni unos (Whisper) za uređaje bez Web Speech API-ja.
* `POST /api/speak` — sinteza govora (TTS), rezervirano za glasovni izgovor odgovora.

## Privatnost, sigurnost i autorska prava

Bez obrade osobnih podataka; anonimizirani logovi (hash IP-a sa soli);
service-role ključ isključivo na poslužitelju; RLS na svim tablicama;
rate-limit na chatu; disclaimer u sučelju. **Knjiga je autorsko djelo** — sadržaj
knjige ne objavljujte u javnom repozitoriju bez dopuštenja nositelja prava
(vidi [`knowledge/README.md`](knowledge/README.md)).
