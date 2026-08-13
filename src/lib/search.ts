import { type SQL, sql } from 'drizzle-orm'

import { db } from '@/db'

export const PAGE_SIZE = 24

export type SearchResult = {
  id: number
  slug: string
  name: string
  coverUrl: string | null
  firstReleaseDate: string | null
  totalRating: number | null
  totalRatingCount: number
  category: string
  status: string | null
}

export type SearchResponse = {
  results: SearchResult[]
  total: number
}

export type SearchParams = {
  query: string
  genreIds: number[]
  platformIds: number[]
  page: number
}

/**
 * Postgres arrays as literals rather than bound parameters.
 *
 * Safe because every element has already been through parseIds, which discards
 * anything that isn't a positive integer — there is no path from user input to
 * this string that isn't a number.
 */
const intArray = (values: number[]) => sql.raw(`'{${values.join(',')}}'::smallint[]`)

function facetConditions({ genreIds, platformIds }: SearchParams): SQL[] {
  const conditions: SQL[] = []

  if (genreIds.length > 0) {
    conditions.push(sql`g.genre_ids @> ${intArray(genreIds)}`)
  }
  if (platformIds.length > 0) {
    conditions.push(sql`g.platform_ids @> ${intArray(platformIds)}`)
  }

  return conditions
}

/** Search, or browse when there's no query. */
export async function searchGames(params: SearchParams): Promise<SearchResponse> {
  const offset = (params.page - 1) * PAGE_SIZE
  const conditions = facetConditions(params)
  const where = (extra: SQL[] = []) => {
    const all = [...extra, ...conditions]
    return all.length > 0 ? sql`WHERE ${sql.join(all, sql` AND `)}` : sql``
  }

  if (params.query.length === 0) {
    /**
     * Browse view: base games by weighted rating.
     *
     * Restricted to main_game because IGDB lists every Game of the Year and
     * Complete Edition as its own entry — without it the front page is four
     * different editions of The Witcher 3 and no other RPG. Ordering on the
     * precomputed weighted_rating is what keeps a 99-from-85-votes below a
     * 94-from-5,404.
     *
     * Two queries, not one with count(*) OVER (): the window function has to
     * read every matching row to produce the total, which turns an ordered
     * index scan into a 21k-row sequential scan — measured at 59ms against
     * 0.16ms. Paying for the count separately, and in parallel, keeps the row
     * fetch on games_browse_idx where the ordering is already materialised.
     */
    const filter = where([
      sql`g.category = 'main_game'`,
      sql`g.weighted_rating IS NOT NULL`,
    ])

    const [rows, counted] = await Promise.all([
      db.execute<SearchResult>(sql`
        SELECT g.id, g.slug, g.name,
               g.cover_url AS "coverUrl",
               g.first_release_date AS "firstReleaseDate",
               g.total_rating AS "totalRating",
               g.total_rating_count AS "totalRatingCount",
               g.category, g.status
        FROM games g
        ${filter}
        ORDER BY g.weighted_rating DESC NULLS LAST
        LIMIT ${PAGE_SIZE} OFFSET ${offset}
      `),
      db.execute<{ total: number }>(sql`
        SELECT count(*)::int AS total FROM games g ${filter}
      `),
    ])

    return {
      results: rows as unknown as SearchResult[],
      total: (counted as unknown as { total: number }[])[0]?.total ?? 0,
    }
  }

  /**
   * Two independent strategies, unioned:
   *
   *   fts   — weighted tsvector match. Handles real words and stems them, and
   *           ranks a title hit above a mention in a summary.
   *   fuzzy — trigram word_similarity. Handles misspellings, which full-text
   *           search cannot match at all.
   *
   * Results are ordered by match tier, then popularity, then ts_rank — see the
   * fts CTE for why that order and not a single combined score.
   *
   * count(*) OVER () is fine here, unlike in the browse path above: the CTE has
   * already narrowed things to the handful of rows that matched, so the window
   * function reads a few hundred rows rather than the whole table.
   */
  const rows = await db.execute<SearchResult & { total: number }>(sql`
    WITH q AS (
      /*
       * Both dictionaries, OR'd.
       *
       * Titles are indexed with 'simple' and summaries with 'english', so a
       * query parsed only as 'english' silently fails against any title the
       * stemmer alters: searching "bloodborne" produces the lexeme
       * 'bloodborn', which never matches the 'bloodborne' token in the title.
       * Bloodborne was unfindable by name — the editions only ranked because
       * their English-stemmed summaries mention it.
       */
      SELECT websearch_to_tsquery('simple',  ${params.query})
          || websearch_to_tsquery('english', ${params.query}) AS tsq,
             ${params.query}::text AS raw
    ),
    fts AS (
      /*
       * Match quality as a tier, not a number added to ts_rank.
       *
       * ts_rank sums term frequencies, so an edition that repeats the name
       * across its alternate titles scores above the game itself — "the
       * witcher 3" returned the Game of the Year Edition ahead of a base game
       * with ten times the ratings, because 2.73 beats 2.52 before popularity
       * is ever consulted. Tiering makes the ordering explicit: how well the
       * title matches first, how many people rated it second, and ts_rank only
       * as a tiebreak.
       */
      SELECT g.id,
             CASE
               WHEN lower(g.name) = lower(q.raw) THEN 4
               WHEN lower(g.name) LIKE lower(q.raw) || '%' THEN 3
               WHEN lower(g.name) LIKE '%' || lower(q.raw) || '%' THEN 2
               ELSE 1
             END AS tier,
             ts_rank(g.search_vector, q.tsq) AS rank
      FROM games g, q
      WHERE g.search_vector @@ q.tsq
    ),
    fuzzy AS (
      -- Tier 0: a misspelling is a last resort, never a peer of a real match.
      SELECT g.id, 0 AS tier, word_similarity(q.raw, g.name) AS rank
      FROM games g, q
      WHERE q.raw <% g.name
    ),
    matched AS (
      SELECT id, max(tier) AS tier, max(rank) AS rank
      FROM (SELECT * FROM fts UNION ALL SELECT * FROM fuzzy) hits
      GROUP BY id
    )
    SELECT g.id, g.slug, g.name,
           g.cover_url AS "coverUrl",
           g.first_release_date AS "firstReleaseDate",
           g.total_rating AS "totalRating",
           g.total_rating_count AS "totalRatingCount",
           g.category, g.status,
           count(*) OVER ()::int AS total
    FROM matched m
    JOIN games g ON g.id = m.id
    ${where()}
    ORDER BY m.tier DESC, g.total_rating_count DESC, m.rank DESC
    LIMIT ${PAGE_SIZE} OFFSET ${offset}
  `)

  const results = rows as unknown as (SearchResult & { total: number })[]

  return { results, total: results[0]?.total ?? 0 }
}

export type Facet = { id: number; name: string; slug: string }

export async function listGenres(): Promise<Facet[]> {
  const rows = await db.execute<Facet>(sql`
    SELECT id, name, slug FROM genres ORDER BY name
  `)
  return rows as unknown as Facet[]
}

/**
 * IGDB has 220 platforms, most of them obscure. The sidebar shows the ones
 * with enough games to be worth filtering by.
 */
export async function listPlatforms(limit = 24): Promise<Facet[]> {
  const rows = await db.execute<Facet>(sql`
    SELECT p.id, p.name, p.slug
    FROM platforms p
    JOIN game_platforms gp ON gp.platform_id = p.id
    GROUP BY p.id
    ORDER BY count(*) DESC
    LIMIT ${limit}
  `)
  return rows as unknown as Facet[]
}

/** Query-string ids are user input: keep positive integers, discard the rest. */
export function parseIds(value: string | string[] | undefined): number[] {
  if (value === undefined) return []

  const raw = Array.isArray(value) ? value : value.split(',')

  return raw
    .map((entry) => Number.parseInt(entry, 10))
    .filter((id) => Number.isSafeInteger(id) && id > 0)
}
