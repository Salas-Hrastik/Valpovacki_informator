# AI asistent ljudskih potencijala — tehnički prijedlog

Edukativni RAG (Retrieval-Augmented Generation) asistent „Petra" odgovara na
pitanja iz **menadžmenta ljudskih potencijala** isključivo na temelju knjige
**Menadžment ljudskih potencijala**. Struktura elemenata preuzeta je od
postojećih edukativnih asistenata (gastronomski asistent, gradski informator)
i prilagođena specifičnostima područja i korpusa (knjiga umjesto weba).

## 1. Arhitektura

```
korisnik ──► Next.js 14 (Vercel)
              ├─ / (chat sučelje)  ─► POST /api/chat ── SSE stream
              ├─ /widget (embed)                │
              └─ /api/ingest (ručno)            ▼
                                        retrieval (pgvector + FTS + rerank)
knowledge/ (knjiga: PDF/MD/TXT)                 │
   └─ ingest (poglavlja → chunkovi              ▼
      → embeddingi) ───────────────► Supabase (Postgres + pgvector)
                                                │
                                                ▼
                                     Claude (Messages API, streaming)
```

* **Frontend**: Next.js App Router, bez dodatnih UI biblioteka; elementi:
  info-traka (datum/blagdan/imendan), logotip, naslov s dobrodošlicom (modal),
  chat s prijedlozima pitanja, citati izvora (poglavlja knjige), glasovni unos
  (Web Speech / snimanje + Whisper), „Kopiraj", „Novi razgovor", disclaimer,
  embed widget (`public/widget.js` + `/widget`).
* **Backend**: API rute (Node runtime), Supabase preko service-role ključa,
  Claude Messages API sa streamingom (SSE).

## 2. Korpus: knjiga umjesto weba

Ključna razlika prema gradskom informatoru: korpus je **statična knjiga**, ne
web koji se mijenja. Posljedice:

| Element | Informator (web) | HR asistent (knjiga) |
|---|---|---|
| Izvor | sitemapovi + crawler + robots.txt | datoteke u `knowledge/` (PDF/MD/TXT) |
| Jedinica dokumenta | web stranica / PDF | poglavlje/odjeljak knjige |
| Identifikator | URL | stabilna referenca `knjiga://mlp/<datoteka>/<NNN>-<slug>` |
| Citat | naziv + URL + „provjereno" | naslov poglavlja + raspon stranica |
| Osvježavanje | cron (dnevno/tjedno) | jednokratno nakon promjene knjige (bez crona) |
| OCR | fallback za skenirane dokumente | knjiga mora imati tekstualni sloj (OCR unaprijed, npr. ocrmypdf) |

### Podjela na odjeljke (lib/ingest/book.ts)

1. **PDF**: tekst se izvlači po stranicama (vlastiti `pagerender` s markerom
   `\f`), pa se naslovi poglavlja prepoznaju heuristikom (numerirani naslovi
   `2.3 Naslov`, redci VELIKIM SLOVIMA). Svaki odjeljak nosi raspon stranica za
   citate. Ako se prepozna premalo naslova → rezervna podjela na prozore od
   `PAGES_PER_SECTION` stranica.
2. **Markdown** (preporučeno za najbolju kvalitetu): odjeljci po naslovima
   `#`/`##`/`###`.
3. Sitni odjeljci (< `MIN_SECTION_CHARS`) spajaju se s prethodnim.

Provjera podjele bez upisa u bazu: `npm run ingest -- --dry-run`.

## 3. Shema baze (supabase/schema.sql)

Iste tablice kao u informatoru (radi prenosivosti alata): `dokumenti` (jedan
redak = odjeljak knjige; stupac `url` nosi internu referencu, dodan stupac
`pages`), `dijelovi` (chunkovi + FTS tsvector), `ugradnje` (pgvector, HNSW
indeks), `conversation_logs` (anonimizirani zapisi + ocjene). RLS uključen na
svim tablicama, bez politika — pristup samo service-role ključem. RPC:
`match_chunks`, `search_chunks_fts`, `upsert_document_with_chunks` (atomarni
upsert), `touch_document`.

## 4. Retrieval (lib/retrieval.ts)

1. **Vektorski kanal**: embedding upita → `match_chunks` (kosinusna sličnost,
   prag `RAG_SCORE_THRESHOLD`, širi skup za rerank).
2. **Leksički kanal (FTS)** kao rezerva kad vektor vrati premalo — ključan za
   točne stručne pojmove („assessment centar", imena autora) uz toleranciju
   hrvatske sklonidbe (prefiks-upiti na 5 znakova + unaccent).
3. **Reranking** (Claude Haiku): presloži kandidate po stvarnoj relevantnosti —
   bira pravi odjeljak među mnogo tematski sličnih poglavlja. Best-effort s
   timeoutom; pad reranka nikad ne ruši odgovor.
4. **Deduplikacija i proračun**: najviše 3 isječka po odjeljku, ukupno do
   `RAG_CONTEXT_CHAR_BUDGET` znakova konteksta.

Za razliku od informatora NEMA kanala „po svježini" (vijesti/događanja) ni
domenskih filtara — knjiga je statična i jedina.

## 5. Generiranje (app/api/chat/route.ts + lib/prompt.ts)

* Sistemski prompt definira personu (Petra, edukativna asistentica), pravilo
  „odgovaraj isključivo iz priloženih izvora", format citata (poglavlje +
  stranice) te **edukativne uloge**: objasni / sažmi / ispitaj me (kviz) /
  usporedi — sve isključivo na temelju priloženih odjeljaka.
* Kontekst se šalje kao `<izvori><izvor id poglavlje>…</izvor></izvori>` u
  zadnjoj korisničkoj poruci; povijest se šalje bez konteksta (zadnjih 6 krugova).
* Streaming SSE: `delta` (tekst) → `sources` (citati) → `done`; robusno
  mapiranje API-pogrešaka u razumljive hrvatske poruke.
* Rate-limit po IP-u (in-memory, best effort) + anonimizirani zapis razgovora.

## 6. Sučelje — struktura elemenata

Zadržana je struktura elemenata postojećih asistenata; sadržaj prilagođen HR
domeni:

* **Info-traka**: datum, blagdan, imendan (bez lokalne temperature — asistent
  nije vezan uz mjesto).
* **Logotip**: stilizirane tri osobe (tim) + natpis (SVG).
* **Naslov**: „Petra" + podnaslov „AI asistentica ljudskih potencijala" koji
  otvara modal dobrodošlice (namjena servisa, edukativne uloge).
* **Prijedlozi pitanja**: tri općenita HR pitanja (uklj. „Ispitaj me…" kao
  demonstraciju kviza).
* **Citati**: gumb „Izvori (N)" → modal s poglavljima i rasponima stranica
  (bez poveznica — odjeljci knjige nisu web stranice; prave poveznice iz
  odgovora otvaraju se u skočnom pregledniku).
* **Glasovni unos**: Web Speech API; na iOS-u snimanje + `/api/transcribe`
  (Whisper) s auto-stopom na tišinu.
* **Disclaimer**: AI odgovori mogu sadržavati pogreške; servis je edukativan i
  ne zamjenjuje stručni/pravni savjet.

## 7. Evaluacija i dijagnostika

* `npm run eval` — hit@k i preciznost citata nad `scripts/eval-set.json`
  (referentne oznake = podnizi referenci/naslova odjeljaka; izoštriti nakon
  prve ingestije).
* `npm run rag:debug -- "<pitanje>" --find=<oznaka>` — rang traženog odjeljka u
  vektorskom i FTS kanalu.
* `conversation_logs` — pitanja, odgovori, izvori, trajanje, ocjene (1–5).

## 8. Privatnost, sigurnost, autorska prava

* Bez PII: logovi anonimizirani (SHA-256 IP + sol), uputa korisniku da ne unosi
  osobne podatke; RLS bez politika (pristup samo poslužitelju); tajna za
  `/api/ingest`; rate-limit na chatu.
* **Autorska prava**: knjiga je zaštićeno djelo — sadržaj se indeksira za
  potrebe servisa, ali se ne objavljuje u javnom repozitoriju bez dopuštenja
  nositelja prava. Odgovori citiraju izvor (naslov + stranice), što je dobra
  akademska praksa.

## 9. Plan dorada (za zajedničku razradu)

* Popis poglavlja/kurikulum u sučelju (navigacija po temama knjige).
* Način „lekcija": vođeni prolazak kroz poglavlje s provjerama znanja.
* Spremanje napretka kviza (zahtijeva prijavu korisnika — odluka o autentikaciji).
* Izgovor odgovora (TTS `/api/speak` već postoji kao ruta).
* Dodatne knjige/izvori (zakonodavstvo, priručnici) kao zasebni „source".
