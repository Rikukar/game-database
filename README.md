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

## Layout

- `src/db/schema.ts` — the schema, and what migrations are generated from
- `db/migrations/` — generated SQL migrations
- `db/schema.sql` — annotated design notes
- `db/queries.sql` — the main search and recommendation queries
