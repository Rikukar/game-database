/**
 * Loads .env.local before anything else imports src/db, which reads
 * process.env at module scope. Next.js does this automatically; a plain tsx
 * script does not, so this must be the first import in the entrypoint.
 */
import { config } from 'dotenv'

config({ path: '.env.local' })
config({ path: '.env' })

/**
 * Long-running work goes to the direct endpoint, not the pooler.
 *
 * A full ingest holds a connection for minutes and leans on transactions and
 * prepared statements; pgbouncer in transaction mode is the wrong shape for
 * that, and it's the app's request traffic the pooler exists to protect. Neon's
 * Vercel integration provides both URLs under these names.
 */
if (process.env.DATABASE_URL_UNPOOLED) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED
}
