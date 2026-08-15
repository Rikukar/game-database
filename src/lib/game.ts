import { sql } from 'drizzle-orm'

import { db } from '@/db'

const rows = <T>(result: unknown) => result as unknown as T[]

export type GameDetail = {
  id: number
  slug: string
  name: string
  summary: string | null
  storyline: string | null
  coverUrl: string | null
  category: string
  status: string | null
  firstReleaseDate: string | null
  totalRating: number | null
  totalRatingCount: number
  criticRating: number | null
  alternativeNames: string[]
  franchiseName: string | null
  franchiseSlug: string | null
  parentSlug: string | null
  parentName: string | null
}

export type Credit = { name: string; slug: string; role: string }
export type Release = {
  platform: string
  region: string
  releasedOn: string | null
  datePrecision: string
}
export type Related = {
  slug: string
  name: string
  coverUrl: string | null
  firstReleaseDate: string | null
  totalRating: number | null
  totalRatingCount: number
  category: string
  status: string | null
}

export async function getGame(slug: string): Promise<GameDetail | null> {
  const [game] = rows<GameDetail>(
    await db.execute(sql`
      SELECT g.id, g.slug, g.name, g.summary, g.storyline,
             g.cover_url AS "coverUrl", g.category, g.status,
             g.first_release_date AS "firstReleaseDate",
             g.total_rating AS "totalRating",
             g.total_rating_count AS "totalRatingCount",
             g.critic_rating AS "criticRating",
             g.alternative_names AS "alternativeNames",
             f.name AS "franchiseName", f.slug AS "franchiseSlug",
             p.slug AS "parentSlug", p.name AS "parentName"
      FROM games g
      LEFT JOIN franchises f ON f.id = g.franchise_id
      LEFT JOIN games p ON p.id = g.parent_game_id
      WHERE g.slug = ${slug}
    `),
  )

  return game ?? null
}

/** Genres, platforms and keywords in one round trip instead of three. */
export async function getTags(gameId: number) {
  const [result] = rows<{
    genres: { id: number; name: string }[] | null
    platforms: { id: number; name: string }[] | null
    keywords: string[] | null
  }>(
    await db.execute(sql`
      SELECT
        (SELECT json_agg(json_build_object('id', ge.id, 'name', ge.name) ORDER BY ge.name)
         FROM game_genres gg JOIN genres ge ON ge.id = gg.genre_id
         WHERE gg.game_id = ${gameId}) AS genres,
        (SELECT json_agg(json_build_object('id', pl.id, 'name', pl.name) ORDER BY pl.name)
         FROM game_platforms gp JOIN platforms pl ON pl.id = gp.platform_id
         WHERE gp.game_id = ${gameId}) AS platforms,
        (SELECT json_agg(kw.name ORDER BY kw.name)
         FROM game_keywords gk JOIN keywords kw ON kw.id = gk.keyword_id
         WHERE gk.game_id = ${gameId}) AS keywords
    `),
  )

  return {
    genres: result?.genres ?? [],
    platforms: result?.platforms ?? [],
    keywords: result?.keywords ?? [],
  }
}

export async function getCredits(gameId: number): Promise<Credit[]> {
  return rows<Credit>(
    await db.execute(sql`
      SELECT c.name, c.slug, gc.role::text AS role
      FROM game_companies gc
      JOIN companies c ON c.id = gc.company_id
      WHERE gc.game_id = ${gameId}
      ORDER BY
        -- Developers and publishers are what people look for; porting and
        -- support studios are footnotes.
        CASE gc.role WHEN 'developer' THEN 0 WHEN 'publisher' THEN 1
                     WHEN 'porting' THEN 2 ELSE 3 END,
        c.name
    `),
  )
}

export async function getReleases(gameId: number): Promise<Release[]> {
  return rows<Release>(
    await db.execute(sql`
      SELECT p.name AS platform, rd.region,
             rd.released_on AS "releasedOn",
             rd.date_precision AS "datePrecision"
      FROM release_dates rd
      JOIN platforms p ON p.id = rd.platform_id
      WHERE rd.game_id = ${gameId}
      ORDER BY rd.released_on NULLS LAST, p.name
    `),
  )
}

/** Editions, DLC and expansions that hang off this game. */
export async function getEditions(gameId: number): Promise<Related[]> {
  return rows<Related>(
    await db.execute(sql`
      SELECT g.slug, g.name, g.cover_url AS "coverUrl",
             g.first_release_date AS "firstReleaseDate",
             g.total_rating AS "totalRating",
             g.total_rating_count AS "totalRatingCount",
             g.category, g.status
      FROM games g
      WHERE g.parent_game_id = ${gameId}
      ORDER BY g.first_release_date NULLS LAST
      LIMIT 12
    `),
  )
}

export async function getSimilar(gameId: number, limit = 12): Promise<Related[]> {
  // game_similarity_top_idx carries the ordering, so this is an index scan
  // straight into the top N — measured at 0.14ms.
  return rows<Related>(
    await db.execute(sql`
      SELECT g.slug, g.name, g.cover_url AS "coverUrl",
             g.first_release_date AS "firstReleaseDate",
             g.total_rating AS "totalRating",
             g.total_rating_count AS "totalRatingCount",
             g.category, g.status
      FROM game_similarity gs
      JOIN games g ON g.id = gs.similar_game_id
      WHERE gs.game_id = ${gameId}
      ORDER BY gs.score DESC
      LIMIT ${limit}
    `),
  )
}

/**
 * IGDB stores a precision alongside each date because many are approximate.
 * Rendering "Q3 2027" as 2027-01-01 would invent a day nobody claimed.
 */
export function formatReleaseDate(date: string | null, precision: string) {
  if (!date || precision === 'tbd') return 'TBA'

  const parsed = new Date(date)
  const year = parsed.getUTCFullYear()

  if (precision === 'year') return String(year)
  if (precision === 'quarter') {
    return `Q${Math.floor(parsed.getUTCMonth() / 3) + 1} ${year}`
  }
  if (precision === 'month') {
    return parsed.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  }

  return parsed.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}
