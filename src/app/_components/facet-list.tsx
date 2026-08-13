import Link from 'next/link'

import type { Facet } from '@/lib/search'

/**
 * Facets are links, not checkboxes.
 *
 * Toggling one is a navigation — the whole filter state already lives in the
 * URL, so there is nothing for client JavaScript to do here. It also means
 * every filter combination is shareable and works without JS.
 */
export function FacetList({
  title,
  param,
  options,
  selected,
  searchParams,
}: {
  title: string
  param: string
  options: Facet[]
  selected: number[]
  searchParams: URLSearchParams
}) {
  const toggleHref = (id: number) => {
    const next = new URLSearchParams(searchParams)
    const remaining = selected.includes(id)
      ? selected.filter((value) => value !== id)
      : [...selected, id]

    if (remaining.length > 0) next.set(param, remaining.join(','))
    else next.delete(param)

    next.delete('page')

    const query = next.toString()
    return query ? `/?${query}` : '/'
  }

  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider opacity-50">
        {title}
      </h2>
      <ul className="flex flex-wrap gap-1.5 lg:flex-col lg:gap-0.5">
        {options.map((option) => {
          const isSelected = selected.includes(option.id)

          return (
            <li key={option.id}>
              <Link
                href={toggleHref(option.id)}
                scroll={false}
                aria-pressed={isSelected}
                className={`block rounded-md px-2 py-1 text-sm transition ${
                  isSelected
                    ? 'bg-foreground text-background'
                    : 'hover:bg-black/5 dark:hover:bg-white/10'
                }`}
              >
                {option.name}
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
