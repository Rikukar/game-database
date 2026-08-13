import Link from 'next/link'
import { Suspense } from 'react'

import {
  PAGE_SIZE,
  listGenres,
  listPlatforms,
  parseIds,
  searchGames,
} from '@/lib/search'

import { FacetList } from './_components/facet-list'
import { GameCard } from './_components/game-card'
import { SearchField } from './_components/search-field'

type PageSearchParams = { [key: string]: string | string[] | undefined }

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>
}) {
  const params = await searchParams

  const query = (first(params.q) ?? '').trim()
  const genreIds = parseIds(params.genre)
  const platformIds = parseIds(params.platform)
  const page = Math.max(1, Number.parseInt(first(params.page) ?? '1', 10) || 1)

  const [{ results, total }, genres, platforms] = await Promise.all([
    searchGames({ query, genreIds, platformIds, page }),
    listGenres(),
    listPlatforms(),
  ])

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // Rebuilt rather than passed through, so facet links can't inherit a stale page.
  const currentParams = new URLSearchParams()
  if (query) currentParams.set('q', query)
  if (genreIds.length) currentParams.set('genre', genreIds.join(','))
  if (platformIds.length) currentParams.set('platform', platformIds.join(','))

  const pageHref = (target: number) => {
    const next = new URLSearchParams(currentParams)
    if (target > 1) next.set('page', String(target))
    const search = next.toString()
    return search ? `/?${search}` : '/'
  }

  const hasFilters = genreIds.length > 0 || platformIds.length > 0

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 lg:py-12">
      <header className="mb-8">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">Game Database</h1>
        <p className="mb-6 text-sm opacity-60">
          Full-text and fuzzy search across {(46271).toLocaleString('en-US')} games
          from IGDB.
        </p>

        <Suspense fallback={<div className="h-[50px] rounded-lg bg-black/5 dark:bg-white/5" />}>
          <SearchField initialQuery={query} />
        </Suspense>
      </header>

      <div className="lg:grid lg:grid-cols-[13rem_1fr] lg:gap-10">
        <aside className="mb-8 space-y-6 lg:mb-0">
          {hasFilters && (
            <Link href={query ? `/?q=${encodeURIComponent(query)}` : '/'} className="text-sm underline opacity-60 hover:opacity-100">
              Clear filters
            </Link>
          )}
          <FacetList
            title="Genre"
            param="genre"
            options={genres}
            selected={genreIds}
            searchParams={currentParams}
          />
          <FacetList
            title="Platform"
            param="platform"
            options={platforms}
            selected={platformIds}
            searchParams={currentParams}
          />
        </aside>

        <main>
          <p className="mb-4 text-sm opacity-60" aria-live="polite">
            {total === 0
              ? 'No games found'
              : `${total.toLocaleString('en-US')} ${total === 1 ? 'game' : 'games'}`}
            {query && total > 0 && <> matching “{query}”</>}
            {!query && !hasFilters && total > 0 && <> — highest rated</>}
          </p>

          {results.length === 0 ? (
            <p className="rounded-lg border border-dashed border-black/10 p-8 text-center text-sm opacity-60 dark:border-white/15">
              Nothing here. Try a different search or clear the filters.
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4">
              {results.map((game) => (
                <li key={game.id}>
                  <GameCard game={game} />
                </li>
              ))}
            </ul>
          )}

          {lastPage > 1 && (
            <nav className="mt-10 flex items-center justify-between text-sm">
              {page > 1 ? (
                <Link href={pageHref(page - 1)} className="underline hover:opacity-70">
                  ← Previous
                </Link>
              ) : (
                <span className="opacity-30">← Previous</span>
              )}

              <span className="opacity-60 tabular-nums">
                Page {page.toLocaleString('en-US')} of {lastPage.toLocaleString('en-US')}
              </span>

              {page < lastPage ? (
                <Link href={pageHref(page + 1)} className="underline hover:opacity-70">
                  Next →
                </Link>
              ) : (
                <span className="opacity-30">Next →</span>
              )}
            </nav>
          )}
        </main>
      </div>
    </div>
  )
}
