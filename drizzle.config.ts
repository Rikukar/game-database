import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// Next.js reads .env.local automatically; drizzle-kit runs outside Next, so it
// needs to be told. .env is the fallback for CI.
config({ path: '.env.local' })
config({ path: '.env' })

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — copy .env.example to .env.local')
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  strict: true,
  verbose: true,
})
