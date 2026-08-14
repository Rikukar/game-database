/**
 * Creates the Postgres extensions the schema depends on.
 *
 * Drizzle migrations don't manage extensions, and the schema's search indexes
 * (gin_trgm_ops) fail to create without pg_trgm — so this has to run once
 * against a fresh database, before `npm run db:migrate`.
 */
import { config } from 'dotenv'
import postgres from 'postgres'

config({ path: '.env.local' })
config({ path: '.env' })

const EXTENSIONS = ['pg_trgm', 'btree_gin']

// CREATE EXTENSION wants the direct endpoint, same as migrations.
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL

if (!url) {
  console.error('DATABASE_URL is not set — copy .env.example to .env.local')
  process.exit(1)
}

const sql = postgres(url, { max: 1 })

try {
  for (const extension of EXTENSIONS) {
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS ${extension}`)
    console.log(`✓ ${extension}`)
  }
} catch (error) {
  console.error('Failed to create extensions:', error.message)
  process.exit(1)
} finally {
  await sql.end()
}
