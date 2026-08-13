/**
 * Database schema — source of truth for migrations.
 *
 * `drizzle-kit generate` turns this into SQL in db/migrations.
 *
 * The annotated design document, including the phase-2 tables Drizzle can't
 * express yet (partitioned time series, materialized views), lives in
 * db/schema.sql. Comments here explain *why* each choice was made — that
 * reasoning is the point of the project.
 */

import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  check,
  customType,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core'

/** Postgres full-text search vector. Drizzle has no built-in tsvector type. */
const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
})

// ---------------------------------------------------------------------------
// Enums
//
// Enums (not lookup tables) for small closed sets that never need extra
// attributes: no join, and the database rejects bad values. Anything a user
// might browse *by* — genres, platforms — stays a table.
// ---------------------------------------------------------------------------

export const gameCategory = pgEnum('game_category', [
  'main_game',
  'dlc',
  'expansion',
  'standalone_expansion',
  'bundle',
  'remake',
  'remaster',
  'port',
  'episode',
  'season',
  'mod',
])

/**
 * IGDB only sets a status when it isn't the obvious one, so most released
 * games carry no status at all — the column is nullable and null means
 * "released, as far as anyone knows".
 *
 * Worth storing because without it a rumour like "Bloodborne 2" is
 * indistinguishable from a real game.
 */
export const gameStatus = pgEnum('game_status', [
  'released',
  'alpha',
  'beta',
  'early_access',
  'offline',
  'cancelled',
  'rumored',
  'delisted',
])

export const companyRole = pgEnum('company_role', [
  'developer',
  'publisher',
  'porting',
  'supporting',
])

export const libraryStatus = pgEnum('library_status', [
  'wishlist',
  'backlog',
  'playing',
  'completed',
  'dropped',
])

// ---------------------------------------------------------------------------
// Lookup / dimension tables
// ---------------------------------------------------------------------------

export const franchises = pgTable('franchises', {
  id: smallint('id').primaryKey().generatedAlwaysAsIdentity(),
  igdbId: integer('igdb_id').notNull().unique(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
})

export const genres = pgTable('genres', {
  id: smallint('id').primaryKey().generatedAlwaysAsIdentity(),
  igdbId: integer('igdb_id').notNull().unique(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
})

export const platforms = pgTable('platforms', {
  id: smallint('id').primaryKey().generatedAlwaysAsIdentity(),
  igdbId: integer('igdb_id').notNull().unique(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  abbreviation: text('abbreviation'),
  /** 'PlayStation' | 'Xbox' | 'Nintendo' | 'PC' … — for grouping the filter UI. */
  family: text('family'),
  generation: smallint('generation'),
})

export const companies = pgTable(
  'companies',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    igdbId: integer('igdb_id').notNull().unique(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    /**
     * ISO 3166-1 *numeric*, which is what IGDB returns (826, not "GB").
     * Rendering the name is a client-side lookup rather than 250 rows of
     * reference table nobody queries.
     */
    country: smallint('country'),
    foundedAt: date('founded_at'),
    description: text('description'),
  },
  (t) => [
    index('companies_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
  ],
)

/**
 * Free-form tags ("time-loop", "immersive-sim"). ~30k of them in IGDB, and we
 * want to browse and count by keyword, so this is a table rather than an array
 * column on games.
 */
export const keywords = pgTable('keywords', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  igdbId: integer('igdb_id').notNull().unique(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
})

// ---------------------------------------------------------------------------
// games — the core table
// ---------------------------------------------------------------------------

export const games = pgTable(
  'games',
  {
    /**
     * Surrogate key keeps foreign keys narrow and stable; the unique igdbId
     * below makes ingest idempotent (ON CONFLICT (igdb_id) DO UPDATE), so
     * re-running the seed is safe and resumable.
     */
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    igdbId: integer('igdb_id').notNull().unique(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    category: gameCategory('category').notNull().default('main_game'),

    /** Self-reference: DLC, remasters and episodes point at their base game. */
    parentGameId: integer('parent_game_id').references(
      (): AnyPgColumn => games.id,
      { onDelete: 'set null' },
    ),
    franchiseId: smallint('franchise_id').references(() => franchises.id, {
      onDelete: 'set null',
    }),

    summary: text('summary'),
    storyline: text('storyline'),
    coverUrl: text('cover_url'),
    /** Denormalized convenience column; release_dates holds the real answer. */
    firstReleaseDate: date('first_release_date'),

    status: gameStatus('status'),

    /** User ratings only. */
    igdbRating: real('igdb_rating'),
    igdbRatingCount: integer('igdb_rating_count').notNull().default(0),
    /** Critic aggregate only. */
    criticRating: real('critic_rating'),

    /**
     * Users and critics combined — what the ingest filter selects on, so this
     * is the pair that actually explains why a game is in the database. Using
     * the user-only count for display meant 21,540 games showed "0 ratings"
     * despite qualifying on critic scores alone.
     */
    totalRating: real('total_rating'),
    totalRatingCount: integer('total_rating_count').notNull().default(0),

    /**
     * Bayesian average of totalRating, pulled toward the global mean in
     * proportion to how few votes a game has.
     *
     * Sorting on the raw rating puts "Grand Theft Auto V: Special Edition"
     * (99 from 85 votes) above The Witcher 3 (94 from 5,404) — the top of the
     * list fills with obscure entries that a handful of people loved. This
     * needs a global constant to compute, so it can't be a generated column;
     * the ingest recomputes it during finalize.
     */
    weightedRating: real('weighted_rating'),

    /**
     * Denormalized bag of searchable text assembled at ingest: alternative
     * titles, franchise name, developer name. A generated column can only read
     * columns in its own row, so anything from a joined table has to be
     * flattened here first. One extra ingest step buys search that stays a
     * single-table index scan.
     */
    searchExtra: text('search_extra').notNull().default(''),

    /**
     * Regional and alternate titles ("Biohazard" for Resident Evil). Stored so
     * searchExtra can be recomputed entirely in SQL after ingest instead of
     * depending on what happened to be in memory at insert time.
     */
    alternativeNames: text('alternative_names').array().notNull().default([]),

    /**
     * These duplicate the junction tables below. The junctions are the source
     * of truth; the arrays exist so multi-facet filtering ("indie roguelikes on
     * Switch") is one GIN containment check instead of N joins plus
     * GROUP BY … HAVING count(*) = N. Rebuilt from the junctions at ingest.
     */
    genreIds: smallint('genre_ids').array().notNull().default([]),
    platformIds: smallint('platform_ids').array().notNull().default([]),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    /**
     * Weighted search vector. An exact title hit must outrank a passing mention
     * in a summary, hence setweight A/B/C.
     *
     * 'simple' for titles — game names are full of non-words ("Nier", "FTL",
     * "0x10c") that the English stemmer mangles. 'english' for prose, so a
     * search for "dragon" matches a summary that says "dragons".
     */
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`setweight(to_tsvector('simple',  coalesce(name, '')),         'A') ||
          setweight(to_tsvector('simple',  coalesce(search_extra, '')), 'B') ||
          setweight(to_tsvector('english', coalesce(summary, '')),      'C')`,
    ),
  },
  (t) => [
    /** Ranked full-text search. */
    index('games_search_idx').using('gin', t.searchVector),

    /**
     * Typo tolerance ("skyrm" → Skyrim). Complements rather than replaces the
     * tsvector index: full-text handles words, trigrams handle misspellings,
     * and neither covers the other. The search query unions both.
     *
     * Queried with word_similarity (<%), not similarity (%) — see the note in
     * db/queries.sql. Same index serves both operators.
     */
    index('games_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),

    /** Facet filtering against the denormalized arrays. */
    index('games_genres_idx').using('gin', t.genreIds),
    index('games_platforms_idx').using('gin', t.platformIds),

    /** "Newest releases" — matches the ORDER BY so the sort is read off the index. */
    index('games_release_idx').on(sql`${t.firstReleaseDate} DESC NULLS LAST`),

    /**
     * Partial index: top-rated lists always exclude thinly-rated games, so the
     * index only stores rows that can ever appear in that query. Roughly a
     * tenth the size of the equivalent full index.
     */
    index('games_top_rated_idx')
      .on(sql`${t.igdbRating} DESC`)
      .where(sql`${t.igdbRatingCount} >= 50`),

    /**
     * Serves the browse view, which is always base games ordered by weighted
     * rating. Partial on category so it stores ~26k rows rather than 46k, and
     * the ordering lives in the index so there is no sort at all.
     */
    index('games_browse_idx')
      .on(sql`${t.weightedRating} DESC NULLS LAST`)
      .where(sql`${t.category} = 'main_game'`),

    index('games_parent_idx')
      .on(t.parentGameId)
      .where(sql`${t.parentGameId} IS NOT NULL`),
    index('games_franchise_idx')
      .on(t.franchiseId)
      .where(sql`${t.franchiseId} IS NOT NULL`),

    check(
      'games_rating_range',
      sql`${t.igdbRating} IS NULL OR ${t.igdbRating} BETWEEN 0 AND 100`,
    ),
    check('games_not_own_parent', sql`${t.parentGameId} IS DISTINCT FROM ${t.id}`),
  ],
)

// ---------------------------------------------------------------------------
// Junction tables (many-to-many)
//
// The recurring trick: a composite primary key creates ONE index, ordered
// (a, b). It answers "genres of this game" instantly and "games in this genre"
// not at all — and the second is what every browse page actually runs. So every
// junction gets an explicit reverse index.
// ---------------------------------------------------------------------------

export const gameGenres = pgTable(
  'game_genres',
  {
    gameId: integer('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    genreId: smallint('genre_id')
      .notNull()
      .references(() => genres.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.gameId, t.genreId] }),
    index('game_genres_reverse_idx').on(t.genreId, t.gameId),
  ],
)

export const gamePlatforms = pgTable(
  'game_platforms',
  {
    gameId: integer('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    platformId: smallint('platform_id')
      .notNull()
      .references(() => platforms.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.gameId, t.platformId] }),
    index('game_platforms_reverse_idx').on(t.platformId, t.gameId),
  ],
)

export const gameKeywords = pgTable(
  'game_keywords',
  {
    gameId: integer('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    keywordId: integer('keyword_id')
      .notNull()
      .references(() => keywords.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.gameId, t.keywordId] }),
    index('game_keywords_reverse_idx').on(t.keywordId, t.gameId),
  ],
)

export const gameCompanies = pgTable(
  'game_companies',
  {
    gameId: integer('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    role: companyRole('role').notNull(),
  },
  (t) => [
    /**
     * Role is part of the key: a studio can be both developer and publisher of
     * the same game, and those are two legitimate rows, not a duplicate.
     */
    primaryKey({ columns: [t.gameId, t.companyId, t.role] }),
    index('game_companies_reverse_idx').on(t.companyId, t.role, t.gameId),
  ],
)

// ---------------------------------------------------------------------------
// release_dates — the temporal dimension
//
// One game ships on many platforms in many regions on different dates. This is
// why games.firstReleaseDate is a convenience column and this is the truth:
// "when did it come out?" has no single answer.
// ---------------------------------------------------------------------------

export const releaseDates = pgTable(
  'release_dates',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    gameId: integer('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    platformId: smallint('platform_id')
      .notNull()
      .references(() => platforms.id, { onDelete: 'cascade' }),
    region: text('region').notNull().default('worldwide'),
    releasedOn: date('released_on'),
    /**
     * IGDB gives fuzzy dates ("Q3 2027"). Storing the precision lets the UI
     * render "2027" instead of a fabricated January 1st.
     */
    datePrecision: text('date_precision').notNull().default('day'),
  },
  (t) => [
    /** Makes re-ingest idempotent — one row per game/platform/region. */
    unique('release_dates_game_platform_region_key').on(
      t.gameId,
      t.platformId,
      t.region,
    ),
    index('release_dates_game_idx').on(t.gameId),
    /** "Upcoming on PS5" — platform first, then the date range. */
    index('release_dates_platform_idx').on(
      t.platformId,
      sql`${t.releasedOn} DESC NULLS LAST`,
    ),
    /** Cross-platform release calendar. */
    index('release_dates_upcoming_idx')
      .on(t.releasedOn)
      .where(sql`${t.releasedOn} IS NOT NULL`),
    check(
      'release_dates_precision_valid',
      sql`${t.datePrecision} IN ('day', 'month', 'quarter', 'year', 'tbd')`,
    ),
  ],
)

// ---------------------------------------------------------------------------
// Users and libraries
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  /** OAuth provider subject — never a password; auth is delegated. */
  externalId: text('external_id').notNull().unique(),
  username: text('username').notNull().unique(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const libraryEntries = pgTable(
  'library_entries',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    gameId: integer('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    status: libraryStatus('status').notNull().default('backlog'),
    rating: smallint('rating'),
    hoursPlayed: numeric('hours_played', { precision: 6, scale: 1 }),
    notes: text('notes'),
    startedAt: date('started_at'),
    finishedAt: date('finished_at'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /**
     * The composite PK doubles as the "already in my library" uniqueness
     * constraint — no separate unique index needed.
     */
    primaryKey({ columns: [t.userId, t.gameId] }),

    /** The library screen filters by status within one user's rows. */
    index('library_user_status_idx').on(
      t.userId,
      t.status,
      sql`${t.updatedAt} DESC`,
    ),
    /** The detail page aggregates across users ("1,204 people are playing this"). */
    index('library_game_idx').on(t.gameId, t.status),
    /** Community score: only rated rows participate. */
    index('library_ratings_idx')
      .on(t.gameId, t.rating)
      .where(sql`${t.rating} IS NOT NULL`),

    check('library_rating_range', sql`${t.rating} BETWEEN 1 AND 10`),
    check('library_hours_positive', sql`${t.hoursPlayed} >= 0`),
    check(
      'library_finished_after_started',
      sql`${t.finishedAt} IS NULL OR ${t.startedAt} IS NULL OR ${t.finishedAt} >= ${t.startedAt}`,
    ),
  ],
)

// ---------------------------------------------------------------------------
// Derived data
// ---------------------------------------------------------------------------

/**
 * Precomputed similarity. Computing tag overlap on the fly across ~70k games is
 * a self-join over millions of junction rows; computing it nightly and keeping
 * the top 20 per game turns the read path into one index scan.
 */
export const gameSimilarity = pgTable(
  'game_similarity',
  {
    gameId: integer('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    similarGameId: integer('similar_game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    score: real('score').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.gameId, t.similarGameId] }),
    /**
     * The read path is always "top N similar to X", so the sort order lives in
     * the index. A primary key can't carry DESC, hence the separate index.
     */
    index('game_similarity_top_idx').on(t.gameId, sql`${t.score} DESC`),
    check('similarity_not_self', sql`${t.gameId} <> ${t.similarGameId}`),
  ],
)

/**
 * Ingest progress, one row per stage.
 *
 * The IGDB sweep is keyset-paginated by id, so recording the last id seen makes
 * a crashed run resumable without re-walking ~1,500 API pages. The upserts are
 * idempotent regardless — this only saves time, never correctness.
 */
export const ingestCheckpoints = pgTable('ingest_checkpoints', {
  stage: text('stage').primaryKey(),
  lastIgdbId: integer('last_igdb_id').notNull().default(0),
  processed: integer('processed').notNull().default(0),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export type Game = typeof games.$inferSelect
export type NewGame = typeof games.$inferInsert
export type LibraryEntry = typeof libraryEntries.$inferSelect
