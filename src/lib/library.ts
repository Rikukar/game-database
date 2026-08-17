import { and, eq, sql } from 'drizzle-orm'

import { currentUserId } from '@/auth'
import { db } from '@/db'
import { libraryEntries, libraryStatus } from '@/db/schema'
import { LIBRARY_STATUSES, type LibraryEntry, type LibraryStatus } from '@/lib/library-status'

/**
 * Library reads. Constants live in library-status.ts so client components can
 * import them without pulling in the database driver; the mutations live in
 * library-actions.ts, which carries the "use server" directive.
 */

/**
 * Compile-time check that the hand-written status list still matches the
 * Postgres enum. Assigning each to the other's type fails the build if a value
 * is added on one side only — which is the whole risk of duplicating them.
 */
function assertStatusesMatchSchema() {
  const fromSchema: LibraryStatus[] = [...libraryStatus.enumValues]
  const fromConstants: (typeof libraryStatus.enumValues)[number][] = [...LIBRARY_STATUSES]
  return { fromSchema, fromConstants }
}
void assertStatusesMatchSchema

export async function getLibraryEntry(gameId: number): Promise<LibraryEntry> {
  const userId = await currentUserId()
  if (!userId) return null

  const [entry] = await db
    .select({ status: libraryEntries.status, rating: libraryEntries.rating })
    .from(libraryEntries)
    .where(
      and(eq(libraryEntries.userId, userId), eq(libraryEntries.gameId, gameId)),
    )

  return entry ?? null
}

export type LibraryGame = {
  slug: string
  name: string
  coverUrl: string | null
  firstReleaseDate: string | null
  totalRating: number | null
  totalRatingCount: number
  category: string
  status: string | null
  entryStatus: LibraryStatus
  rating: number | null
}

/** One user's library, newest change first. Served by library_user_status_idx. */
export async function getLibrary(status?: LibraryStatus) {
  const userId = await currentUserId()

  if (!userId) {
    return { games: [] as LibraryGame[], counts: {} as Record<string, number> }
  }

  const filter = status ? sql`AND le.status = ${status}` : sql``

  const games = (await db.execute(sql`
    SELECT g.slug, g.name, g.cover_url AS "coverUrl",
           g.first_release_date AS "firstReleaseDate",
           g.total_rating AS "totalRating",
           g.total_rating_count AS "totalRatingCount",
           g.category, g.status,
           le.status::text AS "entryStatus", le.rating
    FROM library_entries le
    JOIN games g ON g.id = le.game_id
    WHERE le.user_id = ${userId} ${filter}
    ORDER BY le.updated_at DESC
    LIMIT 200
  `)) as unknown as LibraryGame[]

  const rows = (await db.execute(sql`
    SELECT le.status::text AS status, count(*)::int AS count
    FROM library_entries le
    WHERE le.user_id = ${userId}
    GROUP BY le.status
  `)) as unknown as { status: string; count: number }[]

  return {
    games,
    counts: Object.fromEntries(rows.map((row) => [row.status, row.count])),
  }
}
