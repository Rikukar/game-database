import Image from 'next/image'

import type { SearchResult } from '@/lib/search'

/** IGDB's t_cover_big is 264×374. */
const COVER_WIDTH = 264
const COVER_HEIGHT = 374

/**
 * Anything that isn't a plain released game gets a badge.
 *
 * IGDB is a database rather than a storefront: it tracks mods, cancelled
 * projects and rumoured sequels alongside shipped games. "Bloodborne 2" is a
 * real IGDB record flagged Rumored, and "Grand Theft Auto: Brasil" is a real
 * mod — both belong in search results, but presenting them identically to a
 * released game is what makes them look like errors.
 *
 * Status wins over category when both apply: that a game was cancelled matters
 * more than that it was going to be an expansion.
 */
const STATUS_LABELS: Record<string, string> = {
  cancelled: 'Cancelled',
  rumored: 'Rumoured',
  alpha: 'Alpha',
  beta: 'Beta',
  early_access: 'Early access',
  offline: 'Offline',
  delisted: 'Delisted',
}

const CATEGORY_LABELS: Record<string, string> = {
  dlc: 'DLC',
  expansion: 'Expansion',
  standalone_expansion: 'Expansion',
  bundle: 'Bundle',
  remake: 'Remake',
  remaster: 'Remaster',
  port: 'Port',
  episode: 'Episode',
  season: 'Season',
  mod: 'Mod',
}

function badgeFor(game: SearchResult) {
  if (game.status && game.status !== 'released') {
    return STATUS_LABELS[game.status] ?? null
  }
  return CATEGORY_LABELS[game.category] ?? null
}

function formatVotes(count: number) {
  if (count === 0) return null
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k ratings`
  return `${count} rating${count === 1 ? '' : 's'}`
}

export function GameCard({ game }: { game: SearchResult }) {
  // 5,832 games have no release date — unannounced, cancelled or simply
  // unrecorded. A blank looks like a rendering bug; "TBA" is information.
  const year = game.firstReleaseDate?.slice(0, 4) ?? 'TBA'
  const rating = game.totalRating === null ? null : Math.round(game.totalRating)
  const votes = formatVotes(game.totalRatingCount)
  const badge = badgeFor(game)

  return (
    <article className="group">
      <div
        className="relative aspect-[3/4] overflow-hidden rounded-lg bg-black/5
                   dark:bg-white/5"
      >
        {game.coverUrl ? (
          <Image
            src={game.coverUrl}
            alt=""
            width={COVER_WIDTH}
            height={COVER_HEIGHT}
            /**
             * IGDB already serves these at exactly the size we render, and
             * running 46,000 covers through Vercel's optimizer would burn the
             * free tier's quota on the first crawl for no visual gain.
             */
            unoptimized
            loading="lazy"
            className="size-full object-cover transition duration-300
                       group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-xs opacity-40">
            No cover
          </div>
        )}

        {rating !== null && (
          <span
            className="absolute right-1.5 top-1.5 rounded bg-black/75 px-1.5 py-0.5
                       text-xs font-medium tabular-nums text-white backdrop-blur-sm"
          >
            {rating}
          </span>
        )}

        {badge && (
          <span
            className="absolute left-1.5 top-1.5 rounded bg-white/90 px-1.5 py-0.5
                       text-[0.65rem] font-medium uppercase tracking-wide text-black
                       backdrop-blur-sm"
          >
            {badge}
          </span>
        )}
      </div>

      <h3 className="mt-2 line-clamp-2 text-sm font-medium leading-snug">
        {game.name}
      </h3>
      {/*
        The vote count is here to explain the ordering. Results are sorted by a
        vote-weighted rating, so without it a list reading 86, 94, 97 looks
        arbitrary rather than deliberate.
      */}
      <p className="text-xs opacity-50">
        {year}
        {votes && ` · ${votes}`}
      </p>
    </article>
  )
}
