import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// Next.js reads .env.local automatically; drizzle-kit runs outside Next, so it
// needs to be told. .env is the fallback for CI.
config({ path: '.env.local' })
config({ path: '.env' })

/**
 * Migrations run against the direct endpoint. DDL and pgbouncer's transaction
 * pooling don't mix, and locally there is only one URL anyway.
 */
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL

if (!url) {
  throw new Error('DATABASE_URL is not set — copy .env.example to .env.local')
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
})
