# Game Database

A game discovery app built on PostgreSQL. Data comes from the IGDB API.

Work in progress — the schema and migrations are done, the ingest and UI are next.

## Stack

Next.js, TypeScript, PostgreSQL, Drizzle ORM, Tailwind CSS.

## Setup

Requires Node 22+ and Docker.

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

## Notes on the data

IGDB is a database, not a storefront — it tracks mods, cancelled projects,
betas and rumoured sequels alongside released games. "Bloodborne 2" is a real
IGDB record flagged `Rumored`; "Grand Theft Auto: Brasil" is a real mod. Both
are kept and labelled rather than filtered out, since a cancelled game is often
the interesting one.

Browse only shows released base games ordered by a Bayesian weighted rating, so
a 100/100 from five votes doesn't outrank a 94 from five thousand. Search covers
everything, with a badge on anything that isn't a plain released game.

## Layout

- `src/db/schema.ts` — the schema, and what migrations are generated from
- `src/ingest/` — the IGDB client and ingest pipeline
- `db/migrations/` — generated SQL migrations
- `db/schema.sql` — annotated design notes
- `db/queries.sql` — the main search and recommendation queries
