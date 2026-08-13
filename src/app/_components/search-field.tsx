'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'

/** Long enough to not fire on every keystroke, short enough to feel live. */
const DEBOUNCE_MS = 250

export function SearchField({ initialQuery }: { initialQuery: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [value, setValue] = useState(initialQuery)
  const [isPending, startTransition] = useTransition()

  /**
   * The current params are read through a ref rather than listed as a
   * dependency. As a dependency they re-run this effect after every
   * navigation — including the ones it triggers itself — which turns one
   * keystroke into an unbounded loop of identical requests.
   */
  const paramsRef = useRef(searchParams)

  useEffect(() => {
    paramsRef.current = searchParams
  }, [searchParams])

  useEffect(() => {
    const timer = setTimeout(() => {
      const params = new URLSearchParams(paramsRef.current)

      if (value) params.set('q', value)
      else params.delete('q')

      // Any new search starts from the first page — page 4 of the old results
      // has nothing to do with the new ones.
      params.delete('page')

      // Belt and braces: never navigate to the URL we are already on, which
      // is also what makes landing on /?q=zelda a no-op instead of a redirect.
      const target = params.toString()
      if (target === paramsRef.current.toString()) return

      startTransition(() => router.replace(target ? `/?${target}` : '/', { scroll: false }))
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [value, router])

  return (
    <div className="relative">
      <input
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Search 46,000 games…"
        aria-label="Search games"
        className="w-full rounded-lg border border-black/10 bg-white px-4 py-3 pr-10 text-base
                   outline-none transition placeholder:text-black/40
                   focus:border-black/30 focus:ring-4 focus:ring-black/5
                   dark:border-white/15 dark:bg-white/5 dark:placeholder:text-white/30
                   dark:focus:border-white/30 dark:focus:ring-white/10"
      />
      {isPending && (
        <span
          aria-hidden
          className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin
                     rounded-full border-2 border-current border-t-transparent opacity-40"
        />
      )}
    </div>
  )
}
