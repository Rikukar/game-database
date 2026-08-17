/**
 * Client-safe library status constants.
 *
 * Deliberately imports nothing. The values are duplicated from the
 * `library_status` Postgres enum rather than derived from the Drizzle schema,
 * because importing the schema from a client component drags drizzle and the
 * postgres driver into the browser bundle.
 *
 * The duplication is checked at compile time — see assertStatusesMatchSchema in
 * library.ts, which fails to build if the two ever drift apart.
 */

export const LIBRARY_STATUSES = [
  'wishlist',
  'backlog',
  'playing',
  'completed',
  'dropped',
] as const

export type LibraryStatus = (typeof LIBRARY_STATUSES)[number]

export const STATUS_LABELS: Record<LibraryStatus, string> = {
  wishlist: 'Wishlist',
  backlog: 'Backlog',
  playing: 'Playing',
  completed: 'Completed',
  dropped: 'Dropped',
}

export type LibraryEntry = {
  status: LibraryStatus
  rating: number | null
} | null
