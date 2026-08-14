import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from './schema'

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error('DATABASE_URL is not set — copy .env.example to .env.local')
}

const isProduction = process.env.NODE_ENV === 'production'

/**
 * Next.js hot-reloads modules in dev, which would open a fresh pool on every
 * edit until Postgres refuses new connections. Cache the client on globalThis
 * so reloads reuse it.
 */
const globalForDb = globalThis as unknown as { client?: postgres.Sql }

const client =
  globalForDb.client ??
  postgres(connectionString, {
    /**
     * Serverless multiplies pools: every warm instance keeps its own, so the
     * ceiling is max × instances, not max. Five is enough for the handful of
     * queries a page issues in parallel without a traffic spike turning into
     * connection exhaustion at the pooler.
     */
    max: isProduction ? 5 : 10,

    /**
     * Hand connections back rather than holding them across an idle instance's
     * lifetime — a suspended lambda otherwise pins them until the pooler
     * times them out.
     */
    idle_timeout: 20,

    /**
     * Neon suspends idle databases on the free tier and the first connection
     * has to wait for it to wake, which takes longer than the 30s default
     * makes obvious when it fails.
     */
    connect_timeout: 30,

    /**
     * Neon's pooled endpoint runs pgbouncer in transaction mode, which does not
     * support the extended-protocol prepared statements postgres.js uses by
     * default. Harmless against a direct connection.
     */
    prepare: false,
  })

if (!isProduction) {
  globalForDb.client = client
}

export const db = drizzle(client, { schema })
export { schema }

/**
 * Closes the pool so a CLI script can exit. Never call this from the app —
 * Next.js reuses the module across requests.
 */
export const closeDb = () => client.end()
