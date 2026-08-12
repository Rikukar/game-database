/**
 * Loads .env.local before anything else imports src/db, which reads
 * process.env at module scope. Next.js does this automatically; a plain tsx
 * script does not, so this must be the first import in the entrypoint.
 */
import { config } from 'dotenv'

config({ path: '.env.local' })
config({ path: '.env' })
