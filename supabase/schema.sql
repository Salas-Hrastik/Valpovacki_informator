-- ===========================================================================
-- Valpovački AI gradski informator — shema baze (Supabase / PostgreSQL)
--
-- Primjena: Supabase Dashboard → SQL Editor → zalijepite i izvršite,
-- ili lokalno:  psql "$SUPABASE_DB_URL" -f supabase/schema.sql
--
-- !! VAŽNO — DIMENZIJA VEKTORA !!
-- Stupac ugradnje.ugradnja deklariran je kao vector(1536), što odgovara
-- zadanome modelu OpenAI text-embedding-3-small (EMBEDDING_DIM=1536).
-- Koristite li drugi model (npr. voyage-3 → 1024, text-embedding-3-large →
-- 3072), zamijenite SVA pojavljivanja "vector(1536)" odgovarajućom
-- dimenzijom i uskladite ENV varijablu EMBEDDING_DIM, zatim ponovno
-- pokrenite ingestiju (postojeće vektore treba izračunati iznova).
-- ===========================================================================

-- Ekstenzije -----------------------------------------------------------------
create extension if not exists vector;        -- pgvector (vektorsko pretraživanje)
create extension if not exists pgcrypto;      -- gen_random_uuid()
create extension if not exists unaccent;      -- uklanjanje dijakritika za FTS

-- ---------------------------------------------------------------------------
-- Tablica: dokumenti — jedan redak po izvornome web dokumentu (HTML ili PDF)
-- ---------------------------------------------------------------------------
create table if not exists dokumenti (
  id            uuid primary key default gen_random_uuid(),
  url           text not null unique,
  title         text not null default '',
  source        text not null default '',          -- npr. "valpovo.hr" (host izvora)
  lang          text not null default 'hr',
  municipality  text not null default 'Valpovo',   -- grad/naselje na koje se odnosi
  content_raw   text,                              -- sirovi HTML (radi dijagnostike; može se izostaviti)
  content_text  text not null default '',          -- očišćeni tekst
  content_hash  text not null,                     -- SHA-256 očišćenog teksta (detekcija promjena)
  published_at  timestamptz,                       -- datum objave (ako je dostupan na stranici)
  fetched_at    timestamptz not null default now(),-- kada je dokument zadnji put dohvaćen/provjeren
  updated_at    timestamptz not null default now()
);

create index if not exists dokumenti_source_idx on dokumenti (source);
create index if not exists dokumenti_hash_idx   on dokumenti (content_hash);

-- ---------------------------------------------------------------------------
-- Tablica: dijelovi — tekstualni isječci (chunkovi) dokumenta
--   fts: generirani tsvector stupac za leksičko pretraživanje.
--   Napomena: PostgreSQL nema ugrađenu konfiguraciju za hrvatski jezik,
--   stoga koristimo 'simple' + unaccent (vidi funkciju fts_norm niže) —
--   za rezervni leksički kanal to je u praksi sasvim dovoljno.
-- ---------------------------------------------------------------------------
create or replace function fts_norm(p text)
returns text language sql immutable as $$
  select unaccent(lower(coalesce(p, '')))
$$;

create table if not exists dijelovi (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references dokumenti (id) on delete cascade,
  chunk_index  int  not null,
  text         text not null,
  tokens_est   int  not null default 0,            -- gruba procjena broja tokena
  fts          tsvector generated always as (to_tsvector('simple', fts_norm(text))) stored,
  unique (document_id, chunk_index)
);

create index if not exists dijelovi_document_idx on dijelovi (document_id);
create index if not exists dijelovi_fts_idx      on dijelovi using gin (fts);

-- ---------------------------------------------------------------------------
-- Tablica: ugradnje — vektorske reprezentacije isječaka
-- ---------------------------------------------------------------------------
create table if not exists ugradnje (
  chunk_id    uuid primary key references dijelovi (id) on delete cascade,
  ugradnja    vector(1536) not null,                -- <-- USKLADITI s EMBEDDING_DIM!
  norm        real not null default 1.0,            -- L2 norma vektora (dijagnostika)
  created_at  timestamptz not null default now()
);

-- HNSW indeks za kosinusnu udaljenost (preporučeno za <1M vektora; bolji
-- recall od ivfflat i ne zahtijeva "training"). Alternativa (ivfflat):
--   create index on ugradnje using ivfflat (ugradnja vector_cosine_ops) with (lists = 100);
create index if not exists ugradnje_hnsw_idx
  on ugradnje using hnsw (ugradnja vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Tablica: conversation_logs — anonimizirani zapisi razgovora (evaluacija)
-- Ne pohranjuju se osobni podaci; user_hash je sol+hash IP adrese (opcionalno).
-- ---------------------------------------------------------------------------
create table if not exists conversation_logs (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  question     text not null,
  answer       text not null default '',
  sources      jsonb not null default '[]'::jsonb,  -- [{title,url,score}]
  duration_ms  int,
  model        text,
  rating       smallint,                            -- ocjena korisnika: 1 (loše) … 5 (izvrsno)
  user_hash    text                                 -- anonimizirani identifikator (bez PII)
);

create index if not exists conversation_logs_created_idx on conversation_logs (created_at desc);

-- ---------------------------------------------------------------------------
-- RLS: tablice su dostupne isključivo preko service-role ključa (poslužitelj).
-- Anon klijent nema nikakav izravan pristup podacima.
-- ---------------------------------------------------------------------------
alter table dokumenti         enable row level security;
alter table dijelovi          enable row level security;
alter table ugradnje          enable row level security;
alter table conversation_logs enable row level security;
-- (namjerno bez "create policy" — bez politika, anon/authenticated nemaju pristup)

-- ===========================================================================
-- RPC funkcije
-- ===========================================================================

-- Vektorsko pretraživanje: top-K isječaka po kosinusnoj sličnosti -------------
create or replace function match_chunks(
  query_embedding vector(1536),                     -- <-- USKLADITI s EMBEDDING_DIM!
  match_count     int   default 8,
  score_threshold float default 0.0
)
returns table (
  chunk_id   uuid,
  text       text,
  title      text,
  url        text,
  fetched_at timestamptz,
  score      float
)
language sql stable as $$
  select
    d.id                                as chunk_id,
    d.text,
    dok.title,
    dok.url,
    dok.fetched_at,
    1 - (u.ugradnja <=> query_embedding) as score
  from ugradnje u
  join dijelovi  d   on d.id  = u.chunk_id
  join dokumenti dok on dok.id = d.document_id
  where 1 - (u.ugradnja <=> query_embedding) >= score_threshold
  order by u.ugradnja <=> query_embedding
  limit match_count;
$$;

-- Leksičko (FTS) pretraživanje — rezervni kanal --------------------------------
create or replace function search_chunks_fts(
  query_text  text,
  match_count int default 8
)
returns table (
  chunk_id   uuid,
  text       text,
  title      text,
  url        text,
  fetched_at timestamptz,
  score      float
)
language sql stable as $$
  select
    d.id        as chunk_id,
    d.text,
    dok.title,
    dok.url,
    dok.fetched_at,
    ts_rank(d.fts, plainto_tsquery('simple', fts_norm(query_text)))::float as score
  from dijelovi d
  join dokumenti dok on dok.id = d.document_id
  where d.fts @@ plainto_tsquery('simple', fts_norm(query_text))
  order by score desc
  limit match_count;
$$;

-- Transakcijski upsert dokumenta s isječcima i ugradnjama ----------------------
-- Cijeli zahvat (upsert dokumenta → brisanje starih isječaka → umetanje novih
-- isječaka i vektora) izvršava se atomarno unutar jedne funkcije/transakcije.
-- p_chunks: [{ "chunk_index": 0, "text": "...", "tokens_est": 123,
--              "embedding": [0.1, ...], "norm": 1.0 }, ...]
create or replace function upsert_document_with_chunks(
  p_doc    jsonb,
  p_chunks jsonb
)
returns uuid
language plpgsql as $$
declare
  v_doc_id uuid;
begin
  insert into dokumenti (url, title, source, lang, municipality,
                         content_raw, content_text, content_hash,
                         published_at, fetched_at, updated_at)
  values (
    p_doc->>'url',
    coalesce(p_doc->>'title', ''),
    coalesce(p_doc->>'source', ''),
    coalesce(p_doc->>'lang', 'hr'),
    coalesce(p_doc->>'municipality', 'Valpovo'),
    p_doc->>'content_raw',
    coalesce(p_doc->>'content_text', ''),
    p_doc->>'content_hash',
    nullif(p_doc->>'published_at', '')::timestamptz,
    now(),
    now()
  )
  on conflict (url) do update set
    title        = excluded.title,
    source       = excluded.source,
    lang         = excluded.lang,
    municipality = excluded.municipality,
    content_raw  = excluded.content_raw,
    content_text = excluded.content_text,
    content_hash = excluded.content_hash,
    published_at = excluded.published_at,
    fetched_at   = now(),
    updated_at   = now()
  returning id into v_doc_id;

  -- Stari isječci (i kaskadno njihove ugradnje) uklanjaju se u istoj transakciji
  delete from dijelovi where document_id = v_doc_id;

  with ins as (
    insert into dijelovi (document_id, chunk_index, text, tokens_est)
    select v_doc_id,
           (c->>'chunk_index')::int,
           c->>'text',
           coalesce((c->>'tokens_est')::int, 0)
    from jsonb_array_elements(p_chunks) as c
    returning id, chunk_index
  )
  insert into ugradnje (chunk_id, ugradnja, norm)
  select ins.id,
         (c->>'embedding')::vector,
         coalesce((c->>'norm')::real, 1.0)
  from ins
  join jsonb_array_elements(p_chunks) as c
    on (c->>'chunk_index')::int = ins.chunk_index;

  return v_doc_id;
end;
$$;

-- Osvježavanje oznake "zadnje provjereno" kad je sadržaj nepromijenjen ---------
create or replace function touch_document(p_url text)
returns void language sql as $$
  update dokumenti set fetched_at = now() where url = p_url;
$$;
