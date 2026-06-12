# Valpovački AI gradski informator

RAG chatbot na hrvatskom jeziku koji odgovara na pitanja građana Grada Valpova i
pripadajućih naselja na temelju **javno dostupnih** web dokumenata gradske uprave i
povezanih ustanova. Stack: **Next.js 14 (Vercel) + Supabase (Postgres + pgvector) +
Claude (Anthropic Messages API)**, automatsko osvježavanje indeksa **svake subote**.

➡️ Detaljan tehnički prijedlog (arhitektura, shema, dizajnerske odluke, primjeri):
**[docs/TEHNICKI-PRIJEDLOG.md](docs/TEHNICKI-PRIJEDLOG.md)**

> **Dvije važne napomene o modelima:**
> * `claude-3.5-sonnet` je **povučen iz upotrebe** (28. 10. 2025.); zadani model je
>   službena zamjena `claude-sonnet-4-6` (promjenjivo kroz `CLAUDE_MODEL`).
> * Anthropic **ne nudi API za embeddinge** ("claude-embed-v1" ne postoji); zadano je
>   OpenAI `text-embedding-3-small` (1536 dim), alternativno Voyage AI `voyage-3`
>   (1024 dim). Dimenzija mora odgovarati `vector(DIM)` u `supabase/schema.sql`.

---

## Postavljanje (korak po korak)

### 1. Supabase

1. Kreirajte projekt na [supabase.com](https://supabase.com) (regija: `eu-central-1`).
2. **SQL Editor** → zalijepite sadržaj [`supabase/schema.sql`](supabase/schema.sql) →
   **Run**. (Skripta uključuje `create extension vector` — pgvector.)
3. Ako mijenjate model embeddinga, prije izvršavanja uskladite sva pojavljivanja
   `vector(1536)` s dimenzijom vašeg modela (`EMBEDDING_DIM`).
4. Zabilježite **Project URL**, **service_role** i **anon** ključ
   (Project Settings → API).

### 2. Lokalno pokretanje

```bash
cd valpovo-ai-informator
cp .env.example .env.local       # popunite vrijednosti (vidi komentare u datoteci)
npm install
npm run ingest                   # početno indeksiranje izvora
npm run dev                      # http://localhost:3000
```

### 3. Deploy na Vercel

1. Push projekta na GitHub (preporučeno kao zaseban repozitorij).
2. [vercel.com/new](https://vercel.com/new) → import repozitorija (Next.js se
   detektira automatski).
3. **Settings → Environment Variables** → unesite sve varijable iz
   [`.env.example`](.env.example).
4. Deploy. Cron iz [`vercel.json`](vercel.json) automatski je registriran:
   **svake subote u 02:00 UTC** poziva se `/api/ingest`
   (autorizacija: `VERCEL_CRON_SECRET`).

> `maxDuration` ingest rute je 300 s (Vercel Pro). Na Hobby planu smanjite na 60 s u
> `app/api/ingest/route.ts` — zahvaljujući inkrementalnosti (hash sadržaja), korpus
> se dovrši kroz nekoliko uzastopnih pokretanja.

### 4. Ugradnja widgeta na gradsko web sjedište

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
| Ručno pokretanje ingestije | `curl -X POST https://DOMENA/api/ingest -H "x-ingest-secret: $VERCEL_CRON_SECRET"` ili lokalno `npm run ingest` |
| Dodavanje novog izvora | Dopuniti `ALLOWED_HOSTS` i `SITEMAP_URLS`/`SEED_URLS` u Vercel ENV → redeploy → ingestija |
| Promjena modela | `CLAUDE_MODEL` u Vercel ENV (bez izmjene koda) |
| Promjena embeddinga | `EMBEDDING_*` ENV **+ uskladiti `vector(DIM)` u shemi + ponovna ingestija** |
| Nadzor kvalitete | Tablica `conversation_logs` (pitanja, izvori, trajanje, ocjene); `npm run eval` za offline metrike (hit@k, preciznost citata) |
| CI | `.github/workflows/ci.yml` — type-check, lint, build (u monorepu kopirati u korijen) |

## API (sažetak)

* `POST /api/chat` — `{ messages: [{role, content}] }` → SSE stream
  (`delta` → `sources` → `done`).
* `POST /api/ingest` — pokretanje ingestije (zaštićeno `VERCEL_CRON_SECRET`).
* `POST /api/feedback` — `{ rating: 1–5 }` za zadnji odgovor.

## Privatnost i sigurnost

Samo javni izvori (`ALLOWED_HOSTS`, robots.txt); bez obrade osobnih podataka;
anonimizirani logovi; service-role ključ isključivo na poslužitelju; RLS na svim
tablicama; rate-limit na chatu; disclaimer u sučelju. Detalji: odjeljak 11
tehničkog prijedloga.
