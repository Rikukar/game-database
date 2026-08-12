import './env'

import { inArray, sql } from 'drizzle-orm'

import { closeDb, db } from '@/db'
import {
  companies,
  franchises,
  gameCategory,
  gameCompanies,
  gameGenres,
  gameKeywords,
  gamePlatforms,
  games,
  genres,
  ingestCheckpoints,
  keywords,
  platforms,
  releaseDates,
} from '@/db/schema'

import { PermanentError, assertCredentials, count, paginate } from './igdb'

/**
 * IGDB ingest.
 *
 *   npm run ingest              full sweep, resuming any interrupted stage
 *   npm run ingest -- --fresh   ignore checkpoints and start over
 *   npm run ingest -- --limit 2 stop each stage after N pages (smoke test)
 *
 * Stage order matters: everything games reference has to exist first, and
 * anything referencing games has to come after. Within a stage every write is
 * an upsert keyed on igdb_id, so re-running is safe at any point.
 */

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const FRESH = args.includes('--fresh')
const PAGE_LIMIT = (() => {
  const index = args.indexOf('--limit')
  return index === -1 ? Infinity : Number(args[index + 1])
})()

/**
 * Which games to pull. The full catalogue is ~350k entries, most of them
 * coverless stubs that make the UI look broken and the free-tier database
 * look full. Requiring a cover and at least one rating lands around 70k —
 * enough that query performance is a real problem worth solving.
 */
const GAME_FILTER =
  process.env.IGDB_GAME_FILTER ??
  'cover != null & (total_rating_count >= 1 | hypes >= 1)'

/**
 * The same filter expressed against a referenced game, e.g. `game.cover != null`.
 *
 * release_dates and involved_companies both span the entire IGDB catalogue, so
 * without this the ingest downloads ~800k rows to keep ~200k. IGDB evaluates
 * nested filters server-side, which removes well over a thousand requests.
 *
 * Prefixes each field rather than each clause, because clauses can be
 * parenthesised or OR'd together — `(a >= 1 | b >= 1)` has to become
 * `(game.a >= 1 | game.b >= 1)`, not `game.(a >= 1 | b >= 1)`. A field is
 * anything sitting on the left of a comparison operator.
 */
const gameScopedFilter = (path: string) =>
  GAME_FILTER.replace(
    /([a-z_][a-z0-9_.]*)(\s*(?:!=|>=|<=|=|>|<))/gi,
    `${path}.$1$2`,
  )

// ---------------------------------------------------------------------------
// IGDB response shapes (only the fields requested below)
// ---------------------------------------------------------------------------

type Named = { id: number; name?: string; slug?: string }

type IgdbCompany = Named & {
  country?: number
  start_date?: number
  description?: string
}

type IgdbPlatform = Named & {
  abbreviation?: string
  generation?: number
  platform_family?: { name?: string }
}

type IgdbGame = Named & {
  summary?: string
  storyline?: string
  first_release_date?: number
  rating?: number
  rating_count?: number
  aggregated_rating?: number
  cover?: { image_id?: string }
  game_type?: { type?: string }
  parent_game?: number
  franchise?: number
  genres?: number[]
  platforms?: number[]
  keywords?: number[]
  alternative_names?: { name?: string }[]
}

type IgdbInvolvedCompany = {
  id: number
  game?: number
  company?: number
  developer?: boolean
  publisher?: boolean
  porting?: boolean
  supporting?: boolean
}

type IgdbReleaseDate = {
  id: number
  game?: number
  platform?: number
  date?: number
  date_format?: { format?: string }
  release_region?: { region?: string }
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

/**
 * Unix seconds to a Postgres date.
 *
 * IGDB carries founding dates that land in year 0 and earlier — placeholders,
 * mostly. JavaScript will happily format those as "0000-12-31" or the expanded
 * "-000753-04-21", and Postgres rejects both, taking the whole batch with it.
 * Out-of-range dates become null rather than killing the run.
 */
const toDate = (unix?: number) => {
  if (unix == null) return null

  const date = new Date(unix * 1000)
  if (Number.isNaN(date.getTime())) return null

  const year = date.getUTCFullYear()
  if (year < 1 || year > 9999) return null

  return date.toISOString().slice(0, 10)
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

type GameCategory = (typeof gameCategory.enumValues)[number]

/**
 * IGDB's game_type is an open-ended reference table, ours is a closed enum.
 * The four types without an exact counterpart fold into their nearest
 * neighbour rather than silently becoming 'main_game'.
 */
const GAME_TYPES: Record<string, GameCategory> = {
  'main game': 'main_game',
  dlc: 'dlc',
  'dlc/addon': 'dlc',
  expansion: 'expansion',
  'standalone expansion': 'standalone_expansion',
  bundle: 'bundle',
  remake: 'remake',
  remaster: 'remaster',
  port: 'port',
  episode: 'episode',
  season: 'season',
  mod: 'mod',
  'expanded game': 'expansion',
  fork: 'mod',
  pack: 'bundle',
  update: 'dlc',
}

function toGameCategory(type?: string): GameCategory {
  if (!type) return 'main_game'
  return GAME_TYPES[type.toLowerCase()] ?? 'main_game'
}

/** IGDB date formats: YYYYMMMMDD, YYYYMMMM, YYYY, YYYYQ1..Q4, TBD. */
function datePrecision(format?: string) {
  if (!format) return 'day'
  const value = format.toUpperCase()
  if (value.includes('TBD')) return 'tbd'
  if (/Q[1-4]/.test(value)) return 'quarter'
  if (value.includes('DD')) return 'day'
  if (value.includes('MM')) return 'month'
  return 'year'
}

function coverUrl(imageId?: string) {
  return imageId
    ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${imageId}.jpg`
    : null
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

async function loadCheckpoint(stage: string) {
  if (FRESH) return null
  const [row] = await db
    .select()
    .from(ingestCheckpoints)
    .where(sql`${ingestCheckpoints.stage} = ${stage}`)
  return row ?? null
}

async function saveCheckpoint(stage: string, lastIgdbId: number, processed: number) {
  await db
    .insert(ingestCheckpoints)
    .values({ stage, lastIgdbId, processed })
    .onConflictDoUpdate({
      target: ingestCheckpoints.stage,
      set: {
        lastIgdbId,
        processed: sql`${ingestCheckpoints.processed} + ${processed}`,
        updatedAt: new Date(),
      },
    })
}

async function completeStage(stage: string) {
  // A --limit run only saw the first few pages. Marking the stage complete
  // would make the next full run skip it entirely.
  if (PAGE_LIMIT !== Infinity) return

  await db
    .insert(ingestCheckpoints)
    .values({ stage, completedAt: new Date() })
    .onConflictDoUpdate({
      target: ingestCheckpoints.stage,
      set: { completedAt: new Date(), updatedAt: new Date() },
    })
}

/** Wraps a stage with resume, progress reporting and completion marking. */
async function stage<T extends { id: number }>(
  name: string,
  { endpoint, fields, where }: { endpoint: string; fields: string; where?: string },
  handle: (page: T[]) => Promise<void>,
) {
  const checkpoint = await loadCheckpoint(name)

  if (checkpoint?.completedAt) {
    console.log(`${name}: already complete, skipping`)
    return
  }

  const after = checkpoint?.lastIgdbId ?? 0
  const total = await count(endpoint, where)
  console.log(
    `${name}: ${total.toLocaleString()} rows${after ? ` (resuming after id ${after})` : ''}`,
  )

  let done = 0
  let pages = 0

  for await (const page of paginate<T>(endpoint, { fields, where, after })) {
    await handle(page)
    done += page.length
    pages += 1

    const lastId = page[page.length - 1].id
    await saveCheckpoint(name, lastId, page.length)

    process.stdout.write(`\r  ${done.toLocaleString()} / ${total.toLocaleString()}`)
    if (pages >= PAGE_LIMIT) {
      console.log('\n  page limit reached')
      return
    }
  }

  process.stdout.write('\n')
  await completeStage(name)
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

async function syncGenres() {
  await stage<Named>('genres', { endpoint: 'genres', fields: 'name,slug' }, async (page) => {
    await db
      .insert(genres)
      .values(
        page.map((row) => ({
          igdbId: row.id,
          name: row.name ?? 'Unknown',
          slug: row.slug ?? slugify(row.name ?? `genre-${row.id}`),
        })),
      )
      .onConflictDoUpdate({
        target: genres.igdbId,
        set: { name: sql`excluded.name`, slug: sql`excluded.slug` },
      })
  })
}

async function syncPlatforms() {
  await stage<IgdbPlatform>(
    'platforms',
    {
      endpoint: 'platforms',
      fields: 'name,slug,abbreviation,generation,platform_family.name',
    },
    async (page) => {
      await db
        .insert(platforms)
        .values(
          page.map((row) => ({
            igdbId: row.id,
            name: row.name ?? 'Unknown',
            slug: row.slug ?? slugify(row.name ?? `platform-${row.id}`),
            abbreviation: row.abbreviation ?? null,
            family: row.platform_family?.name ?? null,
            generation: row.generation ?? null,
          })),
        )
        .onConflictDoUpdate({
          target: platforms.igdbId,
          set: {
            name: sql`excluded.name`,
            slug: sql`excluded.slug`,
            abbreviation: sql`excluded.abbreviation`,
            family: sql`excluded.family`,
            generation: sql`excluded.generation`,
          },
        })
    },
  )
}

async function syncKeywords() {
  await stage<Named>('keywords', { endpoint: 'keywords', fields: 'name,slug' }, async (page) => {
    await db
      .insert(keywords)
      .values(
        page.map((row) => ({
          igdbId: row.id,
          name: row.name ?? 'Unknown',
          slug: row.slug ?? slugify(row.name ?? `keyword-${row.id}`),
        })),
      )
      .onConflictDoUpdate({
        target: keywords.igdbId,
        set: { name: sql`excluded.name`, slug: sql`excluded.slug` },
      })
  })
}

async function syncFranchises() {
  await stage<Named>('franchises', { endpoint: 'franchises', fields: 'name,slug' }, async (page) => {
    await db
      .insert(franchises)
      .values(
        page.map((row) => ({
          igdbId: row.id,
          name: row.name ?? 'Unknown',
          slug: row.slug ?? slugify(row.name ?? `franchise-${row.id}`),
        })),
      )
      .onConflictDoUpdate({
        target: franchises.igdbId,
        set: { name: sql`excluded.name`, slug: sql`excluded.slug` },
      })
  })
}

async function syncCompanies() {
  await stage<IgdbCompany>(
    'companies',
    { endpoint: 'companies', fields: 'name,slug,country,start_date,description' },
    async (page) => {
      await db
        .insert(companies)
        .values(
          page.map((row) => ({
            igdbId: row.id,
            name: row.name ?? 'Unknown',
            slug: row.slug ?? slugify(row.name ?? `company-${row.id}`),
            country: row.country ?? null,
            foundedAt: toDate(row.start_date),
            description: row.description ?? null,
          })),
        )
        .onConflictDoUpdate({
          target: companies.igdbId,
          set: {
            name: sql`excluded.name`,
            slug: sql`excluded.slug`,
            country: sql`excluded.country`,
            foundedAt: sql`excluded.founded_at`,
            description: sql`excluded.description`,
          },
        })
    },
  )
}

/** igdb_id -> local id, for resolving IGDB's references to our surrogate keys. */
type IdMap = Map<number, number>

type KeyedTable =
  | typeof genres
  | typeof platforms
  | typeof keywords
  | typeof franchises
  | typeof companies
  | typeof games

async function loadIdMap(table: KeyedTable): Promise<IdMap> {
  const rows = await db
    .select({ id: table.id, igdbId: table.igdbId })
    .from(table as typeof genres)
  return new Map(rows.map((row) => [row.igdbId, row.id]))
}

async function syncGames() {
  const [genreIds, platformIds, keywordIds, franchiseIds] = await Promise.all([
    loadIdMap(genres),
    loadIdMap(platforms),
    loadIdMap(keywords),
    loadIdMap(franchises),
  ])

  await stage<IgdbGame>(
    'games',
    {
      endpoint: 'games',
      where: GAME_FILTER,
      fields:
        'name,slug,summary,storyline,first_release_date,rating,rating_count,' +
        'aggregated_rating,cover.image_id,game_type.type,parent_game,franchise,' +
        'genres,platforms,keywords,alternative_names.name',
    },
    async (page) => {
      // parent_game is resolved in a later pass — a game's parent may not be
      // inserted yet, and the FK would reject it.
      const rows = page.map((row) => ({
        igdbId: row.id,
        slug: row.slug ?? slugify(row.name ?? `game-${row.id}`),
        name: row.name ?? 'Unknown',
        category: toGameCategory(row.game_type?.type),
        franchiseId: row.franchise ? (franchiseIds.get(row.franchise) ?? null) : null,
        summary: row.summary ?? null,
        storyline: row.storyline ?? null,
        coverUrl: coverUrl(row.cover?.image_id),
        firstReleaseDate: toDate(row.first_release_date),
        igdbRating: row.rating ?? null,
        igdbRatingCount: row.rating_count ?? 0,
        criticRating: row.aggregated_rating ?? null,
        alternativeNames:
          row.alternative_names
            ?.map((alt) => alt.name)
            .filter((name): name is string => Boolean(name)) ?? [],
      }))

      const inserted = await db
        .insert(games)
        .values(rows)
        .onConflictDoUpdate({
          target: games.igdbId,
          set: {
            slug: sql`excluded.slug`,
            name: sql`excluded.name`,
            category: sql`excluded.category`,
            franchiseId: sql`excluded.franchise_id`,
            summary: sql`excluded.summary`,
            storyline: sql`excluded.storyline`,
            coverUrl: sql`excluded.cover_url`,
            firstReleaseDate: sql`excluded.first_release_date`,
            igdbRating: sql`excluded.igdb_rating`,
            igdbRatingCount: sql`excluded.igdb_rating_count`,
            criticRating: sql`excluded.critic_rating`,
            alternativeNames: sql`excluded.alternative_names`,
            updatedAt: new Date(),
          },
        })
        .returning({ id: games.id, igdbId: games.igdbId })

      const localIds = new Map(inserted.map((row) => [row.igdbId, row.id]))
      const gameIds = inserted.map((row) => row.id)

      const genreRows: { gameId: number; genreId: number }[] = []
      const platformRows: { gameId: number; platformId: number }[] = []
      const keywordRows: { gameId: number; keywordId: number }[] = []

      for (const row of page) {
        const gameId = localIds.get(row.id)
        if (!gameId) continue

        for (const igdbId of row.genres ?? []) {
          const genreId = genreIds.get(igdbId)
          if (genreId) genreRows.push({ gameId, genreId })
        }
        for (const igdbId of row.platforms ?? []) {
          const platformId = platformIds.get(igdbId)
          if (platformId) platformRows.push({ gameId, platformId })
        }
        for (const igdbId of row.keywords ?? []) {
          const keywordId = keywordIds.get(igdbId)
          if (keywordId) keywordRows.push({ gameId, keywordId })
        }
      }

      // Replace rather than merge: a game losing a genre upstream should lose
      // it here too, which an upsert alone would never do.
      await db.transaction(async (tx) => {
        await tx.delete(gameGenres).where(inArray(gameGenres.gameId, gameIds))
        await tx.delete(gamePlatforms).where(inArray(gamePlatforms.gameId, gameIds))
        await tx.delete(gameKeywords).where(inArray(gameKeywords.gameId, gameIds))

        for (const batch of chunk(genreRows, 1000)) {
          await tx.insert(gameGenres).values(batch).onConflictDoNothing()
        }
        for (const batch of chunk(platformRows, 1000)) {
          await tx.insert(gamePlatforms).values(batch).onConflictDoNothing()
        }
        for (const batch of chunk(keywordRows, 1000)) {
          await tx.insert(gameKeywords).values(batch).onConflictDoNothing()
        }
      })
    },
  )
}

/**
 * Second pass for parent_game. Runs after every game exists, because DLC is
 * frequently ingested before the base game it points at.
 */
async function linkParentGames() {
  if ((await loadCheckpoint('parent_games'))?.completedAt) {
    console.log('parent_games: already complete, skipping')
    return
  }

  console.log('parent_games: linking')

  const gameIds = await loadIdMap(games)
  let linked = 0

  for await (const page of paginate<{ id: number; parent_game?: number }>('games', {
    where: `${GAME_FILTER} & parent_game != null`,
    fields: 'parent_game',
  })) {
    const pairs = page
      .map((row) => ({
        id: gameIds.get(row.id),
        parentId: row.parent_game ? gameIds.get(row.parent_game) : undefined,
      }))
      .filter(
        (row): row is { id: number; parentId: number } =>
          row.id !== undefined && row.parentId !== undefined && row.id !== row.parentId,
      )

    if (pairs.length === 0) continue

    // One UPDATE ... FROM (VALUES …) per page rather than one per row: 500
    // round trips to Postgres per page adds minutes for no reason.
    const values = sql.join(
      pairs.map((pair) => sql`(${pair.id}::int, ${pair.parentId}::int)`),
      sql`, `,
    )

    await db.execute(sql`
      UPDATE games SET parent_game_id = v.parent_id
      FROM (VALUES ${values}) AS v(id, parent_id)
      WHERE games.id = v.id
    `)

    linked += pairs.length
    process.stdout.write(`\r  ${linked.toLocaleString()} linked`)
  }

  process.stdout.write('\n')
  await completeStage('parent_games')
}

async function syncInvolvedCompanies() {
  const gameIds = await loadIdMap(games)
  const companyIds = await loadIdMap(companies)

  await stage<IgdbInvolvedCompany>(
    'involved_companies',
    {
      endpoint: 'involved_companies',
      where: gameScopedFilter('game'),
      fields: 'game,company,developer,publisher,porting,supporting',
    },
    async (page) => {
      const rows: { gameId: number; companyId: number; role: 'developer' | 'publisher' | 'porting' | 'supporting' }[] = []

      for (const row of page) {
        // Most involved_companies rows point at games the filter excluded.
        const gameId = row.game ? gameIds.get(row.game) : undefined
        const companyId = row.company ? companyIds.get(row.company) : undefined
        if (!gameId || !companyId) continue

        // The four flags are independent — a studio can be developer and
        // publisher on the same game, which is two rows, not one.
        if (row.developer) rows.push({ gameId, companyId, role: 'developer' })
        if (row.publisher) rows.push({ gameId, companyId, role: 'publisher' })
        if (row.porting) rows.push({ gameId, companyId, role: 'porting' })
        if (row.supporting) rows.push({ gameId, companyId, role: 'supporting' })
      }

      for (const batch of chunk(rows, 1000)) {
        await db.insert(gameCompanies).values(batch).onConflictDoNothing()
      }
    },
  )
}

async function syncReleaseDates() {
  const gameIds = await loadIdMap(games)
  const platformIds = await loadIdMap(platforms)

  await stage<IgdbReleaseDate>(
    'release_dates',
    {
      endpoint: 'release_dates',
      where: gameScopedFilter('game'),
      fields: 'game,platform,date,date_format.format,release_region.region',
    },
    async (page) => {
      const rows: {
        gameId: number
        platformId: number
        region: string
        releasedOn: string | null
        datePrecision: string
      }[] = []

      for (const row of page) {
        const gameId = row.game ? gameIds.get(row.game) : undefined
        const platformId = row.platform ? platformIds.get(row.platform) : undefined
        if (!gameId || !platformId) continue

        rows.push({
          gameId,
          platformId,
          region: row.release_region?.region ?? 'worldwide',
          releasedOn: toDate(row.date),
          datePrecision: datePrecision(row.date_format?.format),
        })
      }

      /**
       * IGDB carries more than one release row for the same game, platform and
       * region — re-releases, storefront entries, plain duplicates. Our unique
       * constraint says there is one, and Postgres rejects an ON CONFLICT that
       * would touch the same row twice in one statement, so the batch has to be
       * deduplicated before it is sent.
       *
       * Earliest date wins: that's the original release, which is what the
       * "when did this come out" question means.
       */
      const deduplicated = new Map<string, (typeof rows)[number]>()
      for (const row of rows) {
        const key = `${row.gameId}:${row.platformId}:${row.region}`
        const existing = deduplicated.get(key)

        if (
          !existing ||
          (row.releasedOn !== null &&
            (existing.releasedOn === null || row.releasedOn < existing.releasedOn))
        ) {
          deduplicated.set(key, row)
        }
      }

      for (const batch of chunk([...deduplicated.values()], 1000)) {
        await db
          .insert(releaseDates)
          .values(batch)
          .onConflictDoUpdate({
            target: [releaseDates.gameId, releaseDates.platformId, releaseDates.region],
            set: {
              releasedOn: sql`excluded.released_on`,
              datePrecision: sql`excluded.date_precision`,
            },
          })
      }
    },
  )
}

/**
 * Rebuilds everything derived from the junction tables.
 *
 * Done in SQL rather than during ingest so it stays correct regardless of how
 * many partial runs it took to get here — and so it can be re-run on its own
 * after a manual fix.
 */
async function finalize() {
  console.log('finalize: rebuilding derived columns')

  await db.execute(sql`
    UPDATE games g SET
      genre_ids = coalesce(
        (SELECT array_agg(gg.genre_id ORDER BY gg.genre_id)
         FROM game_genres gg WHERE gg.game_id = g.id), '{}'),
      platform_ids = coalesce(
        (SELECT array_agg(gp.platform_id ORDER BY gp.platform_id)
         FROM game_platforms gp WHERE gp.game_id = g.id), '{}')
  `)

  // Updating search_extra recomputes the generated search_vector, which is the
  // point: alternate titles, franchise and studio names all become searchable.
  await db.execute(sql`
    UPDATE games g SET search_extra = btrim(regexp_replace(
      coalesce(array_to_string(g.alternative_names, ' '), '') || ' ' ||
      coalesce((SELECT f.name FROM franchises f WHERE f.id = g.franchise_id), '') || ' ' ||
      coalesce((SELECT string_agg(DISTINCT c.name, ' ')
                FROM game_companies gc
                JOIN companies c ON c.id = gc.company_id
                WHERE gc.game_id = g.id
                  AND gc.role IN ('developer', 'publisher')), ''),
      '\\s+', ' ', 'g'))
  `)

  // The planner has no statistics for 70k freshly inserted rows until this runs,
  // and will happily seq-scan everything until it does.
  await db.execute(sql`ANALYZE games, game_genres, game_platforms, game_keywords, game_companies, release_dates`)
}

// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now()

  assertCredentials()

  console.log(`Ingesting games matching: ${GAME_FILTER}`)
  if (FRESH) console.log('(--fresh: ignoring existing checkpoints)')
  if (PAGE_LIMIT !== Infinity) console.log(`(--limit ${PAGE_LIMIT}: ${PAGE_LIMIT} pages per stage)`)
  console.log()

  await syncGenres()
  await syncPlatforms()
  await syncKeywords()
  await syncFranchises()
  await syncCompanies()
  await syncGames()
  await linkParentGames()
  await syncInvolvedCompanies()
  await syncReleaseDates()
  await finalize()

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(games)

  const minutes = ((Date.now() - started) / 60_000).toFixed(1)
  console.log(`\nDone: ${total.toLocaleString()} games in ${minutes} minutes`)
}

main()
  .catch((error) => {
    // Config and query errors are the user's problem to fix, not a bug —
    // a stack trace just buries the one line that matters.
    if (error instanceof PermanentError) {
      console.error(`\n${error.message}`)
    } else {
      console.error('\nIngest failed:', error)
    }
    process.exitCode = 1
  })
  .finally(closeDb)
