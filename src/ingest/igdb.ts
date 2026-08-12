/**
 * IGDB API client.
 *
 * Three things this has to get right:
 *
 *  1. Auth — IGDB rides on Twitch OAuth client credentials. Tokens last ~60
 *     days, but a long ingest can still cross an expiry, so it refreshes.
 *  2. Rate limiting — IGDB allows 4 requests/second. Exceeding it gets the
 *     whole run 429'd, and a full sweep is ~1,500 requests, so this is not
 *     theoretical.
 *  3. Pagination — offsets are capped server-side, which silently truncates a
 *     large sweep. Keyset pagination on id has no ceiling.
 */

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
const API_URL = 'https://api.igdb.com/v4'

/** IGDB's documented ceiling. */
const REQUESTS_PER_SECOND = 4
const MIN_INTERVAL_MS = 1000 / REQUESTS_PER_SECOND

/** IGDB rejects anything larger. */
export const MAX_PAGE_SIZE = 500

const MAX_RETRIES = 5

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Not worth retrying — a bad query or missing config won't fix itself. */
export class PermanentError extends Error {}

type Credentials = { clientId: string; clientSecret: string }

function credentials(): Credentials {
  const clientId = process.env.IGDB_CLIENT_ID
  const clientSecret = process.env.IGDB_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new PermanentError(
      'IGDB_CLIENT_ID and IGDB_CLIENT_SECRET are required. Register an app at ' +
        'https://dev.twitch.tv/console/apps and put them in .env.local',
    )
  }

  return { clientId, clientSecret }
}

/** Fail fast at startup rather than five backoffs into the first request. */
export function assertCredentials() {
  credentials()
}

let cachedToken: { value: string; expiresAt: number } | null = null

async function accessToken(): Promise<string> {
  // One minute of slack so a token can't expire mid-flight.
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value
  }

  const { clientId, clientSecret } = credentials()
  const url = new URL(TOKEN_URL)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('client_secret', clientSecret)
  url.searchParams.set('grant_type', 'client_credentials')

  const response = await fetch(url, { method: 'POST' })

  if (!response.ok) {
    throw new Error(
      `Twitch token request failed: ${response.status} ${await response.text()}`,
    )
  }

  const body = (await response.json()) as {
    access_token: string
    expires_in: number
  }

  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  }

  return cachedToken.value
}

/**
 * Serializes every request through one promise chain, spaced by the rate
 * limit. Requests are sequential rather than concurrent-with-a-semaphore: a
 * full sweep takes about six minutes either way, and this can't burst past the
 * limit on a retry.
 */
let chain: Promise<unknown> = Promise.resolve()
let lastRequestAt = 0

function schedule<T>(task: () => Promise<T>): Promise<T> {
  const result = chain.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastRequestAt = Date.now()
    return task()
  })

  // Keep the chain alive even when a link rejects, or one failure stalls
  // every request queued behind it.
  chain = result.catch(() => undefined)
  return result
}

async function attempt<T>(endpoint: string, query: string): Promise<T> {
  const { clientId } = credentials()
  const token = await accessToken()

  const response = await fetch(`${API_URL}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Client-ID': clientId,
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    body: query,
  })

  if (response.status === 401) {
    // Token rejected — drop it so the retry fetches a fresh one.
    cachedToken = null
    throw new Error('IGDB returned 401, refreshing token')
  }

  if (response.status === 429 || response.status >= 500) {
    throw new Error(`IGDB returned ${response.status}`)
  }

  if (!response.ok) {
    // 4xx other than the two above means a malformed query. Retrying won't
    // fix it, so surface the query alongside IGDB's complaint.
    throw new PermanentError(
      `IGDB rejected the query (${response.status}): ${await response.text()}\n  ${query}`,
    )
  }

  return (await response.json()) as T
}

export async function request<T>(endpoint: string, query: string): Promise<T> {
  let lastError: unknown

  for (let retry = 0; retry < MAX_RETRIES; retry++) {
    try {
      return await schedule(() => attempt<T>(endpoint, query))
    } catch (error) {
      if (error instanceof PermanentError) throw error

      lastError = error
      const backoff = 500 * 2 ** retry
      console.warn(
        `  ${error instanceof Error ? error.message : error} — retrying in ${backoff}ms`,
      )
      await sleep(backoff)
    }
  }

  throw new Error(
    `IGDB request to /${endpoint} failed after ${MAX_RETRIES} attempts: ${lastError}`,
  )
}

type PaginateOptions = {
  fields: string
  /** APICalypse filter, without the `where` keyword. */
  where?: string
  /** Resume point — only ids greater than this are fetched. */
  after?: number
  pageSize?: number
}

/**
 * Walks an endpoint in id order, yielding one page at a time.
 *
 * Keyset (`id > n`) rather than `offset`: IGDB caps how deep an offset can go,
 * and the failure mode is a short result set rather than an error — a sweep
 * that looks like it succeeded while silently missing most of the catalogue.
 */
export async function* paginate<T extends { id: number }>(
  endpoint: string,
  { fields, where, after = 0, pageSize = MAX_PAGE_SIZE }: PaginateOptions,
): AsyncGenerator<T[]> {
  let lastId = after

  for (;;) {
    const filter = [where, `id > ${lastId}`].filter(Boolean).join(' & ')
    const query = `fields ${fields}; where ${filter}; sort id asc; limit ${pageSize};`

    const page = await request<T[]>(endpoint, query)
    if (page.length === 0) return

    yield page

    lastId = page[page.length - 1].id
    if (page.length < pageSize) return
  }
}

/**
 * Total matching rows, for progress reporting.
 *
 * The /count endpoints return a bare object, not the array every other
 * endpoint returns.
 */
export async function count(endpoint: string, where?: string): Promise<number> {
  const query = where ? `where ${where};` : ''
  const result = await request<{ count?: number }>(`${endpoint}/count`, query)
  return result?.count ?? 0
}
