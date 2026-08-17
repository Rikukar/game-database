'use server'

/**
 * Mutations callable from the browser.
 *
 * Separate from library.ts because a "use server" module may only export async
 * functions — exporting the status constants alongside them fails the build.
 * The split is the right boundary anyway: only these three are reachable from a
 * client component, and each re-checks the session itself.
 */

import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { currentUserId } from '@/auth'
import { db } from '@/db'
import { libraryEntries } from '@/db/schema'
import { LIBRARY_STATUSES, type LibraryStatus } from '@/lib/library-status'

async function requireUserId() {
  // A server action is a public endpoint. Anything the client sends about who
  // it is gets ignored; the session is the only authority.
  const userId = await currentUserId()
  if (!userId) throw new Error('Not signed in')

  return userId
}

export async function setStatus(gameId: number, status: LibraryStatus) {
  const userId = await requireUserId()

  if (!LIBRARY_STATUSES.includes(status)) {
    throw new Error(`Unknown status: ${status}`)
  }

  // The composite primary key (user_id, game_id) is what makes this an upsert
  // rather than a select-then-branch — there's no window for a double insert.
  await db
    .insert(libraryEntries)
    .values({ userId, gameId, status })
    .onConflictDoUpdate({
      target: [libraryEntries.userId, libraryEntries.gameId],
      set: { status, updatedAt: new Date() },
    })

  revalidatePath('/library')
}

export async function setRating(gameId: number, rating: number | null) {
  const userId = await requireUserId()

  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 10)) {
    throw new Error(`Rating must be 1-10 or null, got ${rating}`)
  }

  // Rating a game you haven't filed implies you played it.
  await db
    .insert(libraryEntries)
    .values({ userId, gameId, status: 'completed', rating })
    .onConflictDoUpdate({
      target: [libraryEntries.userId, libraryEntries.gameId],
      set: { rating, updatedAt: new Date() },
    })

  revalidatePath('/library')
}

export async function removeFromLibrary(gameId: number) {
  const userId = await requireUserId()

  await db
    .delete(libraryEntries)
    .where(
      and(eq(libraryEntries.userId, userId), eq(libraryEntries.gameId, gameId)),
    )

  revalidatePath('/library')
}
