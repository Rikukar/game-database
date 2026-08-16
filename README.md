# Game Database

A game discovery app built on PostgreSQL. Data comes from the IGDB API.

**Live:** https://game-database-gold.vercel.app

Work in progress — the schema and migrations are done, the ingest and UI are next.

## Stack

Next.js, TypeScript, PostgreSQL, Drizzle ORM, Tailwind CSS.

## Setup

Requires Node 22+ and Docker. Local development runs PostgreSQL 17 via
docker-compose; production is Neon on 18. Anything from 15 up works — the
schema relies on generated columns, `pg_trgm` and partial indexes.

```bash
npm install
cp .env.example .env.local
docker compose up -d
npm run db:setup
npm run dev
```

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Development server |
| `npm run db:generate` | Generate a migration from `src/db/schema.ts` |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:setup` | Create extensions, then migrate |
| `npm run db:studio` | Browse the database in Drizzle Studio |
| `npm run ingest` | Pull data from IGDB |
| `npm run similarity` | Rebuild the "similar games" table (~30s) |

## Ingest

IGDB authenticates through Twitch, so you need a client ID and secret from
[dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) in `.env.local`.

```bash
npm run ingest -- --limit 2   # two pages per stage, to check it works
npm run ingest                # full run, about 15 minutes
```

Every write is an upsert keyed on IGDB's id, so re-running is safe. Progress is
checkpointed per stage, and an interrupted run resumes where it stopped. Use
`--fresh` to ignore checkpoints and start over.

By default it pulls games with a cover that are either rated or anticipated —
about 46,000 of IGDB's 372,000 entries, which skips the coverless stubs without
losing anything people search for. Override with `IGDB_GAME_FILTER` in
`.env.local`; `cover != null` alone gives roughly 313,000.

## Performance

Every figure below comes from `npm run benchmark`, measured against the
production Neon database — 46,293 games, 298,282 keyword links, 144,383 release
dates. Each case is the median of five runs, reporting server-side execution
time from `EXPLAIN ANALYZE` rather than wall clock, so network latency isn't
being passed off as query cost.

The "sequential scan" rows disable index scans for that statement only, which
is a fair stand-in for not having built the index.

Running the same suite against local Docker gives roughly 2× better absolute
numbers on faster hardware, but the same ratios and the same plans — the
conclusions aren't an artefact of one environment.

**Full-text search** — all matches for `bloodborne`, ranked

| Approach | Median |
|---|---:|
| GIN index on the `tsvector` column | **0.09 ms** |
| sequential scan | 163.07 ms |

**Typo-tolerant title match** — `resident evl`

| Approach | Median |
|---|---:|
| GIN trigram index, `word_similarity` | **1.25 ms** |
| sequential scan | 187.18 ms |

**Faceted filter** — two genres and a platform. This is the denormalisation
argument: `genre_ids`/`platform_ids` duplicate the junction tables so the filter
is one GIN containment check rather than joins plus `GROUP BY … HAVING`.

| Approach | Median |
|---|---:|
| denormalised arrays, GIN | **0.29 ms** |
| normalised junctions, `GROUP BY … HAVING` | 3.54 ms |

**Browse page** — 24 rows plus a total count. The obvious single query costs
nearly 900× the row fetch, because `count(*) OVER ()` has to read every matching
row and so throws away the ordered index scan.

| Approach | Median |
|---|---:|
| two queries: rows off `games_browse_idx` | **0.09 ms** |
| two queries: separate `count(*)` | 6.34 ms |
| one query: `count(*) OVER ()` | 79.85 ms |

**Junction reverse lookup** — games in a genre. A composite primary key on
`(game_id, genre_id)` answers "genres of this game" and nothing else, which is
why every junction table carries an explicit index in the opposite order.

| Approach | Median |
|---|---:|
| reverse index `(genre_id, game_id)` | **0.04 ms** |
| no usable index | 4.86 ms |

**Similar games** — top 12 from the precomputed table: **0.09 ms**, an index
scan on `game_similarity_top_idx`. Computing it on demand isn't on the table;
see [Similar games](#similar-games) for why the naive query doesn't finish.

### What isn't fast

Deep pagination. Page 1 is 0.09 ms; page 500 is **71.86 ms**, and the plan
switches from an index scan to a sequential scan because `OFFSET 11976` makes
Postgres walk and discard every preceding row. Nobody browses to page 500, so
it isn't worth fixing yet — but the fix is keyset pagination, ordering by
`(weighted_rating, id)` and carrying the last row forward instead of an offset.
That's the same technique the IGDB ingest already uses, and for the same reason.

## Deploying

Neon for the database, Vercel for the app.

**1. Create a Neon project.** Copy both connection strings — the pooled one
(host contains `-pooler`) and the direct one.

**2. Point a local `.env.production` at it** and set up the schema. Migrations
and the ingest need the direct endpoint; pgbouncer's transaction pooling can't
run DDL or hold a transaction open for a multi-minute ingest.

```bash
DATABASE_URL="<pooled>" DATABASE_URL_UNPOOLED="<direct>" npm run db:setup
DATABASE_URL="<pooled>" DATABASE_URL_UNPOOLED="<direct>" npm run ingest
```

The ingest takes about 11 minutes and is resumable, so a dropped connection
isn't a restart.

**3. Deploy to Vercel** and set the environment variables: `DATABASE_URL`
(pooled), `DATABASE_URL_UNPOOLED` (direct), `IGDB_CLIENT_ID`,
`IGDB_CLIENT_SECRET`. Neon's Vercel integration sets the first two for you
under exactly these names.

Two things to expect on the free tier: the database suspends when idle, so the
first request after a pause waits for it to wake, and roughly 350 MB of storage
is in use — check the current limit before ingesting, and tighten
`IGDB_GAME_FILTER` if it doesn't fit.

## Notes on the data

IGDB is a database, not a storefront — it tracks mods, cancelled projects,
betas and rumoured sequels alongside released games. "Bloodborne 2" is a real
IGDB record flagged `Rumored`; "Grand Theft Auto: Brasil" is a real mod. Both
are kept and labelled rather than filtered out, since a cancelled game is often
the interesting one.

Browse only shows released base games ordered by a Bayesian weighted rating, so
a 100/100 from five votes doesn't outrank a 94 from five thousand. Search covers
everything, with a badge on anything that isn't a plain released game.

## Similar games

`npm run similarity` precomputes the recommendations. It can't be a plain
self-join over shared tags: that generates n² pairs per tag, and the tags are
skewed enough to make it unrunnable — the genre "Adventure" alone covers 19,699
games, or 388 million pairs, with all genres together reaching 1.17 billion.

So candidate pairs come only from keywords used by 500 games or fewer, which
cuts 149 million pairs to 35 million and improves quality at the same time:
"digital distribution" and "steam achievements" describe a storefront, while
"time-loop" and "immersive-sim" describe a game. Genres then score the
candidates rather than generating them.

Scores are a smoothed cosine similarity. Plain cosine rewards having *few*
tags — an obscure game matching one keyword out of one beat Half-Life 2 matching
six out of eighty-four, which is how Portal 2's top recommendation became
"Arkista's Ring". Adding a constant to both tag counts fixes it. The whole
rebuild takes about 30 seconds and reads back as a 0.14ms index scan.

## Layout

- `src/db/schema.ts` — the schema, and what migrations are generated from
- `src/ingest/` — the IGDB client and ingest pipeline
- `db/migrations/` — generated SQL migrations
- `db/schema.sql` — annotated design notes
- `db/queries.sql` — the main search and recommendation queries
