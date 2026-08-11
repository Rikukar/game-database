-- ============================================================================
-- Game database — annotated design reference
--
-- NOT EXECUTED. The executable schema is src/db/schema.ts (Drizzle), which
-- generates the migrations in db/migrations. This file documents the full
-- target design, including the phase-2 pieces Drizzle can't express — the
-- partitioned time-series tables and the materialized view — which will arrive
-- as hand-written migrations.
--
-- Target: PostgreSQL 15+
-- Source data: IGDB API (games, companies, genres, platforms, franchises)
--              Steam / SteamSpy (player counts, prices) — optional second pass
--
-- Comments explain *why* each choice was made. That reasoning is the portfolio
-- value; the tables themselves are the easy part.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- fuzzy / typo-tolerant name matching
CREATE EXTENSION IF NOT EXISTS btree_gin;   -- lets GIN indexes mix arrays + scalars


-- ---------------------------------------------------------------------------
-- Enums
--
-- Enums (not lookup tables) for small, closed sets that never need extra
-- attributes. One byte-ish storage, no join, and the DB rejects bad values.
-- Anything a user might want to browse *by* (genres, platforms) stays a table.
-- ---------------------------------------------------------------------------

CREATE TYPE game_category AS ENUM (
  'main_game', 'dlc', 'expansion', 'standalone_expansion', 'bundle',
  'remake', 'remaster', 'port', 'episode', 'season', 'mod'
);

CREATE TYPE company_role AS ENUM ('developer', 'publisher', 'porting', 'supporting');

CREATE TYPE library_status AS ENUM ('wishlist', 'backlog', 'playing', 'completed', 'dropped');


-- ---------------------------------------------------------------------------
-- Lookup / dimension tables
-- ---------------------------------------------------------------------------

CREATE TABLE franchises (
  id       smallint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  igdb_id  integer NOT NULL UNIQUE,
  slug     text    NOT NULL UNIQUE,
  name     text    NOT NULL
);

CREATE TABLE genres (
  id       smallint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  igdb_id  integer NOT NULL UNIQUE,
  slug     text    NOT NULL UNIQUE,
  name     text    NOT NULL
);

CREATE TABLE platforms (
  id             smallint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  igdb_id        integer NOT NULL UNIQUE,
  slug           text    NOT NULL UNIQUE,
  name           text    NOT NULL,
  abbreviation   text,
  family         text,          -- 'PlayStation', 'Xbox', 'Nintendo', 'PC'…
  generation     smallint
);

CREATE TABLE companies (
  id           integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  igdb_id      integer NOT NULL UNIQUE,
  slug         text    NOT NULL UNIQUE,
  name         text    NOT NULL,
  country      char(2),         -- ISO 3166-1 alpha-2
  founded_at   date,
  description  text
);

CREATE INDEX companies_name_trgm_idx ON companies USING gin (name gin_trgm_ops);

-- Free-form tags. High cardinality (IGDB has ~30k), so its own table rather
-- than an array on games — we want to browse and count by keyword.
CREATE TABLE keywords (
  id       integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  igdb_id  integer NOT NULL UNIQUE,
  slug     text    NOT NULL UNIQUE,
  name     text    NOT NULL
);


-- ---------------------------------------------------------------------------
-- games — the core table
--
-- Design notes:
--
-- * Surrogate `id` + unique `igdb_id`. The surrogate keeps foreign keys narrow
--   and stable; the unique natural key makes the ingest idempotent
--   (INSERT … ON CONFLICT (igdb_id) DO UPDATE), so re-running the seed is safe.
--
-- * `parent_game_id` is a self-reference: DLC and remasters point at the base
--   game. Lets you show "Editions & DLC" without a separate table.
--
-- * `search_extra` is a denormalized bag of text assembled at ingest time
--   (alternative titles, franchise name, developer name). A generated tsvector
--   column can only see columns in *this* row, so anything from a joined table
--   has to be flattened here first. Honest trade-off: one extra ingest step in
--   exchange for search that stays a single-table index scan.
--
-- * `genre_ids` / `platform_ids` duplicate the junction tables below. The
--   junctions are the source of truth; these arrays exist purely so that
--   multi-facet filtering ("indie roguelikes on Switch") is one GIN containment
--   check instead of N joins + GROUP BY … HAVING count(*) = N. Rebuilt from the
--   junctions at ingest, never edited by hand.
-- ---------------------------------------------------------------------------

CREATE TABLE games (
  id                 integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  igdb_id            integer NOT NULL UNIQUE,
  slug               text    NOT NULL UNIQUE,
  name               text    NOT NULL,
  category           game_category NOT NULL DEFAULT 'main_game',
  parent_game_id     integer  REFERENCES games(id)      ON DELETE SET NULL,
  franchise_id       smallint REFERENCES franchises(id) ON DELETE SET NULL,

  summary            text,
  storyline          text,
  cover_url          text,
  first_release_date date,

  igdb_rating        real,
  igdb_rating_count  integer NOT NULL DEFAULT 0,
  critic_rating      real,

  search_extra       text     NOT NULL DEFAULT '',
  genre_ids          smallint[] NOT NULL DEFAULT '{}',
  platform_ids       smallint[] NOT NULL DEFAULT '{}',

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- Weighted vector: an exact title hit must outrank a passing mention in a
  -- summary. 'simple' for names (game titles are full of non-words like
  -- "Nier", "FTL", "0x10c" that the English stemmer would mangle);
  -- 'english' for prose, so a search for "dragon" matches "dragons".
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple',  coalesce(name, '')),         'A') ||
    setweight(to_tsvector('simple',  coalesce(search_extra, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(summary, '')),      'C')
  ) STORED,

  CONSTRAINT games_rating_range CHECK (igdb_rating IS NULL OR igdb_rating BETWEEN 0 AND 100),
  CONSTRAINT games_not_own_parent CHECK (parent_game_id IS DISTINCT FROM id)
);

-- Ranked full-text search.
CREATE INDEX games_search_idx      ON games USING gin (search_vector);

-- Typo tolerance and substring matching ("skyrm" → Skyrim). Complements the
-- tsvector index rather than replacing it: FTS handles words, trigrams handle
-- misspellings. The search query unions both, using word_similarity (<%)
-- rather than similarity (%) — see the note in db/queries.sql.
CREATE INDEX games_name_trgm_idx   ON games USING gin (name gin_trgm_ops);

-- Facet filtering. btree_gin lets one index cover both arrays.
CREATE INDEX games_genres_idx      ON games USING gin (genre_ids);
CREATE INDEX games_platforms_idx   ON games USING gin (platform_ids);

-- "Newest releases" — NULLS LAST matches the query's ORDER BY so the sort is
-- read straight off the index.
CREATE INDEX games_release_idx     ON games (first_release_date DESC NULLS LAST);

-- Partial index: "top rated" lists always exclude thinly-rated games, so the
-- index only stores rows that can ever appear. Roughly a tenth the size of the
-- full index and it never goes stale for this query shape.
CREATE INDEX games_top_rated_idx   ON games (igdb_rating DESC)
  WHERE igdb_rating_count >= 50;

CREATE INDEX games_parent_idx      ON games (parent_game_id) WHERE parent_game_id IS NOT NULL;
CREATE INDEX games_franchise_idx   ON games (franchise_id)   WHERE franchise_id IS NOT NULL;


-- ---------------------------------------------------------------------------
-- Junction tables (many-to-many)
--
-- The recurring trick: a composite primary key creates ONE index, ordered
-- (a, b). It answers "genres of this game" instantly and "games in this genre"
-- not at all. Every junction therefore gets an explicit reverse index.
-- ---------------------------------------------------------------------------

CREATE TABLE game_genres (
  game_id  integer  NOT NULL REFERENCES games(id)  ON DELETE CASCADE,
  genre_id smallint NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
  PRIMARY KEY (game_id, genre_id)
);
CREATE INDEX game_genres_reverse_idx ON game_genres (genre_id, game_id);

CREATE TABLE game_platforms (
  game_id     integer  NOT NULL REFERENCES games(id)     ON DELETE CASCADE,
  platform_id smallint NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  PRIMARY KEY (game_id, platform_id)
);
CREATE INDEX game_platforms_reverse_idx ON game_platforms (platform_id, game_id);

CREATE TABLE game_keywords (
  game_id    integer NOT NULL REFERENCES games(id)     ON DELETE CASCADE,
  keyword_id integer NOT NULL REFERENCES keywords(id)  ON DELETE CASCADE,
  PRIMARY KEY (game_id, keyword_id)
);
CREATE INDEX game_keywords_reverse_idx ON game_keywords (keyword_id, game_id);

-- Role is part of the key: a company can be both developer and publisher of the
-- same game, and those are two legitimate rows, not a duplicate.
CREATE TABLE game_companies (
  game_id    integer      NOT NULL REFERENCES games(id)     ON DELETE CASCADE,
  company_id integer      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role       company_role NOT NULL,
  PRIMARY KEY (game_id, company_id, role)
);
CREATE INDEX game_companies_reverse_idx ON game_companies (company_id, role, game_id);


-- ---------------------------------------------------------------------------
-- release_dates — the temporal dimension
--
-- One game ships on many platforms in many regions on different dates. This is
-- why `games.first_release_date` is a denormalized convenience column and this
-- table is the truth: "when did Elden Ring come out?" has no single answer.
-- ---------------------------------------------------------------------------

CREATE TABLE release_dates (
  id           integer  PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  game_id      integer  NOT NULL REFERENCES games(id)     ON DELETE CASCADE,
  platform_id  smallint NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  region       text     NOT NULL DEFAULT 'worldwide',
  released_on  date,
  -- IGDB gives fuzzy dates ("Q3 2027"). Store the precision so the UI can
  -- render "2027" instead of a fake January 1st.
  date_precision text   NOT NULL DEFAULT 'day'
                        CHECK (date_precision IN ('day', 'month', 'quarter', 'year', 'tbd')),
  UNIQUE (game_id, platform_id, region)
);

CREATE INDEX release_dates_game_idx     ON release_dates (game_id);
-- Drives "upcoming releases on PS5": platform first, then date range.
CREATE INDEX release_dates_platform_idx ON release_dates (platform_id, released_on DESC NULLS LAST);
-- Calendar view across all platforms.
CREATE INDEX release_dates_upcoming_idx ON release_dates (released_on)
  WHERE released_on IS NOT NULL;


-- ---------------------------------------------------------------------------
-- Users and libraries
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id            integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  external_id   text NOT NULL UNIQUE,        -- OAuth provider subject
  username      text NOT NULL UNIQUE,
  display_name  text,
  avatar_url    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Composite PK doubles as the "is this game already in my library" uniqueness
-- constraint — no separate unique index needed.
CREATE TABLE library_entries (
  user_id      integer        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id      integer        NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  status       library_status NOT NULL DEFAULT 'backlog',
  rating       smallint       CHECK (rating BETWEEN 1 AND 10),
  hours_played numeric(6,1)   CHECK (hours_played >= 0),
  notes        text,
  started_at   date,
  finished_at  date,
  updated_at   timestamptz    NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, game_id),
  CONSTRAINT library_finished_after_started
    CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);

-- The library screen filters by status inside one user's rows.
CREATE INDEX library_user_status_idx ON library_entries (user_id, status, updated_at DESC);
-- The game detail page aggregates across users ("1,204 people are playing this").
CREATE INDEX library_game_idx        ON library_entries (game_id, status);
-- Community score: only rated rows participate.
CREATE INDEX library_ratings_idx     ON library_entries (game_id, rating)
  WHERE rating IS NOT NULL;


-- ---------------------------------------------------------------------------
-- Time series — optional second data source, and the best showcase in the schema
--
-- Declarative range partitioning by month. Snapshots every few hours across a
-- few thousand tracked games reaches millions of rows fast; partitioning keeps
-- "last 30 days" queries reading one or two partitions, and retention becomes
-- DROP TABLE (instant) instead of DELETE (slow, bloating).
-- ---------------------------------------------------------------------------

CREATE TABLE player_counts (
  game_id     integer     NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  recorded_at timestamptz NOT NULL,
  players     integer     NOT NULL CHECK (players >= 0),
  PRIMARY KEY (game_id, recorded_at)
) PARTITION BY RANGE (recorded_at);

-- Create these ahead of time (a monthly job, or pg_partman).
CREATE TABLE player_counts_2026_08 PARTITION OF player_counts
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE player_counts_2026_09 PARTITION OF player_counts
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

CREATE TABLE price_history (
  game_id     integer     NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  store       text        NOT NULL,
  currency    char(3)     NOT NULL,
  recorded_at timestamptz NOT NULL,
  price_cents integer     NOT NULL CHECK (price_cents >= 0),
  discount_pct smallint   CHECK (discount_pct BETWEEN 0 AND 100),
  PRIMARY KEY (game_id, store, currency, recorded_at)
);


-- ---------------------------------------------------------------------------
-- Derived data
-- ---------------------------------------------------------------------------

-- Precomputed similarity. Computing overlap on the fly across 200k games is a
-- self-join over millions of junction rows; computing it nightly and storing
-- the top 20 per game turns the read path into a single index scan.
CREATE TABLE game_similarity (
  game_id         integer  NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  similar_game_id integer  NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  score           real     NOT NULL,
  PRIMARY KEY (game_id, similar_game_id),
  CONSTRAINT similarity_not_self CHECK (game_id <> similar_game_id)
);

-- The read path is always "top N similar to X", so the sort order lives in the
-- index. (A primary key can't carry DESC, hence the separate index.)
CREATE INDEX game_similarity_top_idx ON game_similarity (game_id, score DESC);

-- Aggregates for browse/sort screens. REFRESH MATERIALIZED VIEW CONCURRENTLY
-- requires a unique index, so this one is mandatory, not an optimization.
CREATE MATERIALIZED VIEW game_stats AS
SELECT
  g.id AS game_id,
  count(le.user_id)                                        AS library_count,
  count(le.user_id) FILTER (WHERE le.status = 'playing')    AS playing_count,
  count(le.user_id) FILTER (WHERE le.status = 'completed')  AS completed_count,
  avg(le.rating)                                           AS user_rating,
  count(le.rating)                                         AS user_rating_count
FROM games g
LEFT JOIN library_entries le ON le.game_id = g.id
GROUP BY g.id;

CREATE UNIQUE INDEX game_stats_pk_idx      ON game_stats (game_id);
CREATE INDEX        game_stats_popular_idx ON game_stats (library_count DESC);
