'use client'

import { signIn } from 'next-auth/react'
import { useState, useTransition } from 'react'

import {
  removeFromLibrary,
  setRating,
  setStatus,
} from '@/lib/library-actions'
import {
  LIBRARY_STATUSES,
  type LibraryEntry,
  type LibraryStatus,
  STATUS_LABELS,
} from '@/lib/library-status'

export function LibraryControl({
  gameId,
  entry,
  signedIn,
}: {
  gameId: number
  entry: LibraryEntry
  signedIn: boolean
}) {
  /*
   * Optimistic local state rather than useOptimistic: the server action returns
   * nothing to reconcile against, and on failure we want the control to snap
   * back to what the server actually holds, which is what `entry` already is.
   */
  const [current, setCurrent] = useState(entry)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  if (!signedIn) {
    return (
      <p className="mt-6 text-sm opacity-60">
        <button
          type="button"
          onClick={() => signIn('github')}
          className="underline hover:opacity-100"
        >
          Sign in
        </button>{' '}
        to track this game.
      </p>
    )
  }

  const run = (optimistic: LibraryEntry, action: () => Promise<void>) => {
    const previous = current
    setCurrent(optimistic)
    setError(null)

    startTransition(async () => {
      try {
        await action()
      } catch {
        setCurrent(previous)
        setError("Couldn't save that — try again.")
      }
    })
  }

  return (
    <div className="mt-6" aria-busy={isPending}>
      <div className="flex flex-wrap gap-1.5">
        {LIBRARY_STATUSES.map((status: LibraryStatus) => {
          const active = current?.status === status

          return (
            <button
              key={status}
              type="button"
              aria-pressed={active}
              onClick={() =>
                active
                  ? run(null, () => removeFromLibrary(gameId))
                  : run({ status, rating: current?.rating ?? null }, () =>
                      setStatus(gameId, status),
                    )
              }
              className={`rounded-md px-2.5 py-1 text-sm transition ${
                active
                  ? 'bg-foreground text-background'
                  : 'border border-black/15 hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10'
              }`}
            >
              {STATUS_LABELS[status]}
            </button>
          )
        })}
      </div>

      {current && (
        <div className="mt-3 flex flex-wrap items-center gap-1">
          <span className="mr-1 text-xs uppercase tracking-wider opacity-50">
            Your rating
          </span>
          {Array.from({ length: 10 }, (_, index) => index + 1).map((score) => (
            <button
              key={score}
              type="button"
              aria-pressed={current.rating === score}
              onClick={() =>
                run(
                  { ...current, rating: current.rating === score ? null : score },
                  () => setRating(gameId, current.rating === score ? null : score),
                )
              }
              className={`size-7 rounded text-xs tabular-nums transition ${
                current.rating === score
                  ? 'bg-foreground text-background'
                  : 'border border-black/15 hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10'
              }`}
            >
              {score}
            </button>
          ))}
        </div>
      )}

      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
