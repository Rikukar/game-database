import { eq } from 'drizzle-orm'
import NextAuth from 'next-auth'
import GitHub from 'next-auth/providers/github'

import { db } from '@/db'
import { users } from '@/db/schema'

/**
 * Auth.js with GitHub OAuth, JWT sessions, and no database adapter.
 *
 * The adapter is deliberately skipped. It would add accounts, sessions and
 * verification_token tables, but `users.external_id` already exists for exactly
 * this — holding an OAuth subject — and library_entries keys off our own
 * users.id. A JWT session plus one upsert gives us the same thing without three
 * tables nobody queries.
 *
 * The trade-off, stated honestly: JWT sessions can't be revoked server-side
 * before they expire. For a game backlog tracker that's the right side of the
 * trade; for anything holding real consequences it wouldn't be.
 */

/**
 * Where our internal users.id lives on the session.
 *
 * Not a module augmentation. `Session` is declared in @auth/core/types rather
 * than in next-auth, and augmenting either one produced a competing declaration
 * that collapsed the field to `never`. Overriding `session.user.id` is worse
 * still — Auth.js types that as a string for the provider's own subject, and
 * ours is an integer surrogate key.
 *
 * So the cast is confined to this file and callers use currentUserId(), which
 * is the better boundary regardless: nothing outside here needs to know how the
 * id is carried.
 */
const SESSION_USER_ID = 'userId'

/** Our users.id for the signed-in request, or null. */
export async function currentUserId(): Promise<number | null> {
  const session = await auth()
  const id = (session as Record<string, unknown> | null)?.[SESSION_USER_ID]
  return typeof id === 'number' ? id : null
}

/**
 * Finds or creates our row for this OAuth identity.
 *
 * Keyed on `provider:accountId` rather than email — people change emails, and
 * GitHub accounts without a public email would otherwise have no key at all.
 */
async function upsertUser(input: {
  externalId: string
  username: string
  displayName: string | null
  avatarUrl: string | null
}): Promise<number> {
  const insert = (username: string) =>
    db
      .insert(users)
      .values({ ...input, username })
      .onConflictDoUpdate({
        target: users.externalId,
        set: { displayName: input.displayName, avatarUrl: input.avatarUrl },
      })
      .returning({ id: users.id })

  try {
    const [row] = await insert(input.username)
    return row.id
  } catch {
    /*
     * users.username is UNIQUE and separate from external_id, so a GitHub login
     * that already belongs to a different identity would fail the insert even
     * though the upsert on external_id is fine. Rare, but a signup that dies on
     * a name clash is a bad first impression — fall back to a suffixed name.
     */
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.externalId, input.externalId))

    if (existing) return existing.id

    const [row] = await insert(
      `${input.username}-${input.externalId.split(':').pop()}`,
    )
    return row.id
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [GitHub],

  // Vercel sets the deployment URL at runtime rather than build time.
  trustHost: true,

  pages: { signIn: '/' },

  callbacks: {
    async jwt({ token, account, profile }) {
      // `account` is only present on the sign-in request itself, so the upsert
      // runs once per login rather than on every token refresh.
      if (account && profile) {
        const login =
          typeof profile.login === 'string' ? profile.login : `user-${account.providerAccountId}`

        token.dbId = await upsertUser({
          externalId: `${account.provider}:${account.providerAccountId}`,
          username: login,
          displayName: (profile.name as string | null) ?? login,
          avatarUrl: (profile.avatar_url as string | null) ?? null,
        })
      }

      return token
    },

    session({ session, token }) {
      // JWT extends Record<string, unknown>, so dbId comes back untyped.
      if (typeof token.dbId === 'number') {
        ;(session as unknown as Record<string, unknown>)[SESSION_USER_ID] =
          token.dbId
      }
      return session
    },
  },
})
