import Link from 'next/link'

import { auth, signIn, signOut } from '@/auth'

export async function SiteHeader() {
  const session = await auth()

  return (
    <header className="border-b border-black/10 dark:border-white/10">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          Game Database
        </Link>

        <nav className="flex items-center gap-4 text-sm">
          {session?.user ? (
            <>
              <Link href="/library" className="opacity-70 hover:opacity-100">
                My library
              </Link>
              {/*
                Sign-out is a form POST, not a link. A GET that mutates session
                state can be triggered by anything that prefetches the page.
              */}
              <form
                action={async () => {
                  'use server'
                  await signOut({ redirectTo: '/' })
                }}
              >
                <button type="submit" className="opacity-70 hover:opacity-100">
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <form
              action={async () => {
                'use server'
                await signIn('github')
              }}
            >
              <button type="submit" className="opacity-70 hover:opacity-100">
                Sign in with GitHub
              </button>
            </form>
          )}
        </nav>
      </div>
    </header>
  )
}
