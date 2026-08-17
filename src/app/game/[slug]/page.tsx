import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { GameCard } from '@/app/_components/game-card'
import { LibraryControl } from '@/app/_components/library-control'
import { currentUserId } from '@/auth'
import { getLibraryEntry } from '@/lib/library'
import {
  formatReleaseDate,
  getCredits,
  getEditions,
  getGame,
  getReleases,
  getSimilar,
  getTags,
} from '@/lib/game'

const ROLE_LABELS: Record<string, string> = {
  developer: 'Developer',
  publisher: 'Publisher',
  porting: 'Porting',
  supporting: 'Support',
}

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
  standalone_expansion: 'Standalone expansion',
  bundle: 'Bundle',
  remake: 'Remake',
  remaster: 'Remaster',
  port: 'Port',
  episode: 'Episode',
  season: 'Season',
  mod: 'Mod',
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const game = await getGame((await params).slug)
  if (!game) return { title: 'Not found' }

  const year = game.firstReleaseDate?.slice(0, 4)
  return {
    title: `${game.name}${year ? ` (${year})` : ''}`,
    description: game.summary?.slice(0, 160) ?? undefined,
  }
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="mt-10">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider opacity-50">
        {title}
      </h2>
      {children}
    </section>
  )
}

export default async function GamePage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const game = await getGame(slug)

  if (!game) notFound()

  // Everything below depends only on the id, so it goes out in one batch
  // rather than five sequential round trips.
  const [tags, credits, releases, editions, similar, userId, libraryEntry] =
    await Promise.all([
      getTags(game.id),
      getCredits(game.id),
      getReleases(game.id),
      getEditions(game.id),
      getSimilar(game.id),
      currentUserId(),
      getLibraryEntry(game.id),
    ])

  const year = game.firstReleaseDate?.slice(0, 4) ?? 'TBA'
  const rating = game.totalRating === null ? null : Math.round(game.totalRating)
  const badge =
    (game.status && game.status !== 'released' && STATUS_LABELS[game.status]) ||
    CATEGORY_LABELS[game.category] ||
    null

  const byRole = credits.reduce<Record<string, typeof credits>>((acc, credit) => {
    ;(acc[credit.role] ??= []).push(credit)
    return acc
  }, {})

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 lg:py-12">
      <Link href="/" className="text-sm underline opacity-60 hover:opacity-100">
        ← Search
      </Link>

      <div className="mt-6 gap-8 sm:flex">
        <div className="mb-6 w-40 shrink-0 sm:mb-0 sm:w-56">
          <div className="relative aspect-[3/4] overflow-hidden rounded-lg bg-black/5 dark:bg-white/5">
            {game.coverUrl ? (
              <Image
                src={game.coverUrl}
                alt=""
                width={264}
                height={374}
                unoptimized
                priority
                className="size-full object-cover"
              />
            ) : (
              <div className="flex size-full items-center justify-center text-xs opacity-40">
                No cover
              </div>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {badge && (
              <span className="rounded bg-black/10 px-1.5 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide dark:bg-white/15">
                {badge}
              </span>
            )}
            {game.parentSlug && (
              <Link
                href={`/game/${game.parentSlug}`}
                className="text-xs underline opacity-60 hover:opacity-100"
              >
                part of {game.parentName}
              </Link>
            )}
          </div>

          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {game.name}
          </h1>

          <p className="mt-1 text-sm opacity-60">
            {year}
            {game.franchiseName && <> · {game.franchiseName}</>}
          </p>

          {(rating !== null || game.criticRating !== null) && (
            <div className="mt-4 flex gap-6">
              {rating !== null && (
                <div>
                  <div className="text-2xl font-semibold tabular-nums">{rating}</div>
                  <div className="text-xs opacity-50">
                    {game.totalRatingCount.toLocaleString('en-US')} ratings
                  </div>
                </div>
              )}
              {game.criticRating !== null && (
                <div>
                  <div className="text-2xl font-semibold tabular-nums">
                    {Math.round(game.criticRating)}
                  </div>
                  <div className="text-xs opacity-50">critics</div>
                </div>
              )}
            </div>
          )}

          <LibraryControl
            gameId={game.id}
            entry={libraryEntry}
            signedIn={userId !== null}
          />

          {game.summary && (
            <p className="mt-5 max-w-prose text-sm leading-relaxed opacity-80">
              {game.summary}
            </p>
          )}

          <dl className="mt-6 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            {Object.entries(byRole).map(([role, people]) => (
              <div key={role}>
                <dt className="text-xs uppercase tracking-wider opacity-50">
                  {ROLE_LABELS[role] ?? role}
                </dt>
                <dd>{people.map((person) => person.name).join(', ')}</dd>
              </div>
            ))}

            {tags.genres.length > 0 && (
              <div>
                <dt className="text-xs uppercase tracking-wider opacity-50">Genres</dt>
                <dd className="flex flex-wrap gap-x-1.5">
                  {tags.genres.map((genre) => (
                    <Link
                      key={genre.id}
                      href={`/?genre=${genre.id}`}
                      className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
                    >
                      {genre.name}
                    </Link>
                  ))}
                </dd>
              </div>
            )}

            {tags.platforms.length > 0 && (
              <div>
                <dt className="text-xs uppercase tracking-wider opacity-50">Platforms</dt>
                <dd className="flex flex-wrap gap-x-1.5">
                  {tags.platforms.map((platform) => (
                    <Link
                      key={platform.id}
                      href={`/?platform=${platform.id}`}
                      className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
                    >
                      {platform.name}
                    </Link>
                  ))}
                </dd>
              </div>
            )}

            {game.alternativeNames.length > 0 && (
              <div>
                <dt className="text-xs uppercase tracking-wider opacity-50">
                  Also known as
                </dt>
                <dd className="opacity-80">
                  {game.alternativeNames.slice(0, 6).join(' · ')}
                </dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      {game.storyline && game.storyline !== game.summary && (
        <Section title="Storyline">
          <p className="max-w-prose text-sm leading-relaxed opacity-80">
            {game.storyline}
          </p>
        </Section>
      )}

      {releases.length > 0 && (
        <Section title="Releases">
          {/* One game ships on many platforms in many regions on different
              dates — this table is why release_dates is its own table rather
              than a column on games. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-md text-sm">
              <thead>
                <tr className="border-b border-black/10 text-left text-xs uppercase tracking-wider opacity-50 dark:border-white/15">
                  <th className="py-1.5 pr-4 font-medium">Platform</th>
                  <th className="py-1.5 pr-4 font-medium">Region</th>
                  <th className="py-1.5 font-medium">Date</th>
                </tr>
              </thead>
              <tbody>
                {releases.map((release, index) => (
                  <tr
                    key={`${release.platform}-${release.region}-${index}`}
                    className="border-b border-black/5 last:border-0 dark:border-white/10"
                  >
                    <td className="py-1.5 pr-4">{release.platform}</td>
                    <td className="py-1.5 pr-4 capitalize opacity-60">
                      {release.region.replace(/_/g, ' ')}
                    </td>
                    <td className="py-1.5 tabular-nums opacity-80">
                      {formatReleaseDate(release.releasedOn, release.datePrecision)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {editions.length > 0 && (
        <Section title="Editions and add-ons">
          <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-4 lg:grid-cols-6">
            {editions.map((edition) => (
              <li key={edition.slug}>
                <Link href={`/game/${edition.slug}`}>
                  <GameCard game={{ ...edition, id: 0 }} />
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {similar.length > 0 && (
        <Section title="Similar games">
          <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-4 lg:grid-cols-6">
            {similar.map((related) => (
              <li key={related.slug}>
                <Link href={`/game/${related.slug}`}>
                  <GameCard game={{ ...related, id: 0 }} />
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {tags.keywords.length > 0 && (
        <Section title="Tags">
          <p className="text-sm opacity-60">{tags.keywords.slice(0, 24).join(' · ')}</p>
        </Section>
      )}
    </div>
  )
}
