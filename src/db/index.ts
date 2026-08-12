import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from './schema'

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error('DATABASE_URL is not set — copy .env.example to .env.local')
}

/**
 * Next.js hot-reloads modules in dev, which would open a fresh pool on every
 * edit until Postgres refuses new connections. Cache the client on globalThis
 * so reloads reuse it.
 */
const globalForDb = globalThis as unknown as { client?: postgres.Sql }

const client =
  globalForDb.client ??
  postgres(connectionString, {
    max: 10,
    /**
     * Neon's pooled endpoint runs pgbouncer in transaction mode, which does not
     * support the extended-protocol prepared statements postgres.js uses by
     * default. Harmless against a direct connection.
     */
    prepare: false,
  })

if (process.env.NODE_ENV !== 'production') {
  globalForDb.client = client
}

export const db = drizzle(client, { schema })
export { schema }

/**
 * Closes the pool so a CLI script can exit. Never call this from the app —
 * Next.js reuses the module across requests.
 */
export const closeDb = () => client.end()
