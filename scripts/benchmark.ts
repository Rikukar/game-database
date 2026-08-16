import '../src/ingest/env'

import { sql } from 'drizzle-orm'

import { closeDb, db } from '@/db'

/**
 * Benchmarks the queries the schema exists to serve.
 *
 *   npm run benchmark
 *
 * Every figure in the README's performance section comes from this script, so
 * the numbers can be re-derived rather than taken on trust.
 *
 * Each case is run REPEATS times and the median EXPLAIN ANALYZE execution time
 * is reported. Execution time is measured server-side on purpose: wall-clock
 * from here would be dominated by network latency, which says more about where
 * I'm sitting than about the query.
 *
 * The "without index" variants disable index and bitmap scans for that
 * statement only. That's a fair stand-in for not having built the index, and
 * unlike actually dropping one it can't leave the database in a broken state
 * halfway through.
 */

const REPEATS = 5

type Case = {
  group: string
  label: string
  query: string
  /** Session settings applied for this case only. */
  disableIndexes?: boolean
}

const SEARCH_TSQUERY = `websearch_to_tsquery('simple','bloodborne') || websearch_to_tsquery('english','bloodborne')`

const cases: Case[] = [
  // -------------------------------------------------------------------------
  {
    group: 'Full-text search (all matches, ranked)',
    label: 'GIN index on tsvector',
    query: `
      SELECT g.id, ts_rank(g.search_vector, q.tsq) AS rank
      FROM games g, (SELECT ${SEARCH_TSQUERY} AS tsq) q
      WHERE g.search_vector @@ q.tsq
      ORDER BY rank DESC`,
  },
  {
    group: 'Full-text search (all matches, ranked)',
    label: 'sequential scan',
    disableIndexes: true,
    query: `
      SELECT g.id, ts_rank(g.search_vector, q.tsq) AS rank
      FROM games g, (SELECT ${SEARCH_TSQUERY} AS tsq) q
      WHERE g.search_vector @@ q.tsq
      ORDER BY rank DESC`,
  },

  // -------------------------------------------------------------------------
  {
    group: 'Typo-tolerant title match',
    label: 'GIN trigram index',
    query: `SELECT g.id FROM games g WHERE 'resident evl' <% g.name`,
  },
  {
    group: 'Typo-tolerant title match',
    label: 'sequential scan',
    disableIndexes: true,
    query: `SELECT g.id FROM games g WHERE 'resident evl' <% g.name`,
  },

  // -------------------------------------------------------------------------
  // The denormalisation this project argues for. genre_ids/platform_ids
  // duplicate the junction tables; this is whether that was worth it.
  {
    group: 'Faceted filter (2 genres + 1 platform)',
    label: 'denormalised arrays, GIN',
    query: `
      SELECT g.id FROM games g
      WHERE g.genre_ids @> '{12,31}'::smallint[]
        AND g.platform_ids @> '{6}'::smallint[]`,
  },
  {
    group: 'Faceted filter (2 genres + 1 platform)',
    label: 'normalised junctions, GROUP BY HAVING',
    query: `
      SELECT g.id FROM games g
      JOIN game_genres gg ON gg.game_id = g.id AND gg.genre_id IN (12, 31)
      JOIN game_platforms gp ON gp.game_id = g.id AND gp.platform_id = 6
      GROUP BY g.id
      HAVING count(DISTINCT gg.genre_id) = 2`,
  },

  // -------------------------------------------------------------------------
  {
    group: 'Browse page 1 (rows + total)',
    label: 'two queries: indexed rows',
    query: `
      SELECT g.id FROM games g
      WHERE g.category = 'main_game' AND g.weighted_rating IS NOT NULL
      ORDER BY g.weighted_rating DESC NULLS LAST LIMIT 24`,
  },
  {
    group: 'Browse page 1 (rows + total)',
    label: 'two queries: separate count',
    query: `
      SELECT count(*) FROM games g
      WHERE g.category = 'main_game' AND g.weighted_rating IS NOT NULL`,
  },
  {
    group: 'Browse page 1 (rows + total)',
    label: 'one query: count(*) OVER ()',
    query: `
      SELECT g.id, count(*) OVER () AS total FROM games g
      WHERE g.category = 'main_game' AND g.weighted_rating IS NOT NULL
      ORDER BY g.weighted_rating DESC NULLS LAST LIMIT 24`,
  },

  // -------------------------------------------------------------------------
  {
    group: 'Games in a genre (junction reverse lookup)',
    label: 'reverse index (genre_id, game_id)',
    query: `SELECT gg.game_id FROM game_genres gg WHERE gg.genre_id = 31`,
  },
  {
    group: 'Games in a genre (junction reverse lookup)',
    label: 'no usable index',
    disableIndexes: true,
    query: `SELECT gg.game_id FROM game_genres gg WHERE gg.genre_id = 31`,
  },

  // -------------------------------------------------------------------------
  {
    group: 'Similar games (top 12)',
    label: 'precomputed table',
    query: `
      SELECT g.name FROM game_similarity gs
      JOIN games g ON g.id = gs.similar_game_id
      WHERE gs.game_id = (SELECT id FROM games WHERE slug = 'portal-2')
      ORDER BY gs.score DESC LIMIT 12`,
  },

  // -------------------------------------------------------------------------
  {
    group: 'Deep pagination',
    label: 'page 1 (OFFSET 0)',
    query: `
      SELECT g.id FROM games g
      WHERE g.category = 'main_game' AND g.weighted_rating IS NOT NULL
      ORDER BY g.weighted_rating DESC NULLS LAST LIMIT 24`,
  },
  {
    group: 'Deep pagination',
    label: 'page 500 (OFFSET 11976)',
    query: `
      SELECT g.id FROM games g
      WHERE g.category = 'main_game' AND g.weighted_rating IS NOT NULL
      ORDER BY g.weighted_rating DESC NULLS LAST LIMIT 24 OFFSET 11976`,
  },
]

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function measure(testCase: Case) {
  const timings: number[] = []
  let plan = ''

  for (let run = 0; run < REPEATS; run++) {
    const rows = await db.transaction(async (tx) => {
      if (testCase.disableIndexes) {
        await tx.execute(sql`SET LOCAL enable_indexscan = off`)
        await tx.execute(sql`SET LOCAL enable_bitmapscan = off`)
        await tx.execute(sql`SET LOCAL enable_indexonlyscan = off`)
      }
      return tx.execute(
        sql.raw(`EXPLAIN (ANALYZE, COSTS OFF) ${testCase.query}`),
      )
    })

    const lines = (rows as unknown as Record<string, string>[]).map(
      (row) => row['QUERY PLAN'],
    )

    const executionTime = lines.find((line) => line.startsWith('Execution Time'))
    timings.push(Number(executionTime?.match(/([\d.]+) ms/)?.[1] ?? NaN))

    if (run === 0) {
      // Every scan node, not just the first — a query with a subquery lookup
      // would otherwise be reported by the wrong index entirely.
      plan = [
        ...new Set(
          lines
            .filter((line) =>
              /(Index Only Scan|Index Scan|Bitmap Heap Scan|Seq Scan)/.test(line),
            )
            .map((line) =>
              line
                .trim()
                .replace(/^->\s*/, '')
                .replace(/\s*\(actual.*$/, ''),
            ),
        ),
      ].join(' + ')
    }
  }

  return { ms: median(timings), plan }
}

async function main() {
  console.log(`Median of ${REPEATS} runs, server-side execution time.\n`)

  let lastGroup = ''
  const results: { group: string; label: string; ms: number; plan: string }[] = []

  for (const testCase of cases) {
    const { ms, plan } = await measure(testCase)
    results.push({ group: testCase.group, label: testCase.label, ms, plan })

    if (testCase.group !== lastGroup) {
      console.log(`\n${testCase.group}`)
      lastGroup = testCase.group
    }
    console.log(
      `  ${testCase.label.padEnd(38)} ${ms.toFixed(3).padStart(9)} ms   ${plan}`,
    )
  }

  console.log('\n--- markdown ---\n')
  lastGroup = ''
  for (const row of results) {
    if (row.group !== lastGroup) {
      console.log(`\n**${row.group}**\n`)
      console.log('| Approach | Median | Plan |')
      console.log('|---|---:|---|')
      lastGroup = row.group
    }
    console.log(`| ${row.label} | ${row.ms.toFixed(2)} ms | \`${row.plan}\` |`)
  }
}

main()
  .catch((error) => {
    console.error('\nBenchmark failed:', error)
    process.exitCode = 1
  })
  .finally(closeDb)
