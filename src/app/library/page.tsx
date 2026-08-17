import type { Metadata } from 'next'
import Link from 'next/link'

import { GameCard } from '@/app/_components/game-card'
import { currentUserId } from '@/auth'
import { getLibrary } from '@/lib/library'
import {
  LIBRARY_STATUSES,
  type LibraryStatus,
  STATUS_LABELS,
} from '@/lib/library-status'

export const metadata: Metadata = { title: 'My library' }

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const userId = await currentUserId()

  if (!userId) {
    return (
      <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-12 sm:px-6">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight">My library</h1>
        <p className="text-sm opacity-60">
          Sign in to keep track of what you&rsquo;re playing.
        </p>
      </div>
    )
  }

  const requested = (await searchParams).status
  const status = LIBRARY_STATUSES.includes(requested as LibraryStatus)
    ? (requested as LibraryStatus)
    : undefined

  const { games, counts } = await getLibrary(status)
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 lg:py-12">
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">My library</h1>

      <nav className="mb-6 flex flex-wrap gap-1.5 text-sm">
        <Link
          href="/library"
          aria-current={status === undefined ? 'page' : undefined}
          className={`rounded-md px-2.5 py-1 transition ${
            status === undefined
              ? 'bg-foreground text-background'
              : 'hover:bg-black/5 dark:hover:bg-white/10'
          }`}
        >
          All {total > 0 && <span className="tabular-nums opacity-60">{total}</span>}
        </Link>

        {LIBRARY_STATUSES.map((value) => (
          <Link
            key={value}
            href={`/library?status=${value}`}
            aria-current={status === value ? 'page' : undefined}
            className={`rounded-md px-2.5 py-1 transition ${
              status === value
                ? 'bg-foreground text-background'
                : 'hover:bg-black/5 dark:hover:bg-white/10'
            }`}
          >
            {STATUS_LABELS[value]}{' '}
            {counts[value] ? (
              <span className="tabular-nums opacity-60">{counts[value]}</span>
            ) : null}
          </Link>
        ))}
      </nav>

      {games.length === 0 ? (
        <p className="rounded-lg border border-dashed border-black/10 p-8 text-center text-sm opacity-60 dark:border-white/15">
          Nothing here yet.{' '}
          <Link href="/" className="underline">
            Find something to play
          </Link>
          .
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-6">
          {games.map((game) => (
            <li key={game.slug}>
              <Link href={`/game/${game.slug}`}>
                <GameCard game={{ ...game, id: 0 }} />
              </Link>
              <p className="mt-1 text-xs opacity-60">
                {STATUS_LABELS[game.entryStatus]}
                {game.rating !== null && ` · ${game.rating}/10`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
