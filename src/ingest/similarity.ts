import './env'

import { sql } from 'drizzle-orm'

import { closeDb, db } from '@/db'

/**
 * Rebuilds game_similarity.
 *
 *   npm run similarity
 *
 * Separate from the main ingest because it depends on nothing external and
 * takes long enough that you don't want it wedged inside an API sweep.
 *
 * ## Why it isn't a plain self-join
 *
 * The obvious query — join game_keywords and game_genres to themselves and
 * count shared tags — does not finish. A self-join generates n² pairs per tag,
 * and the tags are wildly skewed:
 *
 *   genre "Adventure"          19,699 games →   388,050,601 pairs
 *   genre "Indie"              18,801 games →   353,477,601 pairs
 *   all genres together                    → 1,174,397,559 pairs
 *   all keywords together                  →   149,489,038 pairs
 *
 * So genres are never used to *generate* candidate pairs, only to score pairs
 * that keywords already proposed. And keywords above MAX_KEYWORD_FREQUENCY are
 * skipped entirely.
 *
 * Dropping the common keywords costs nothing in quality and is arguably an
 * improvement: "digital distribution" (4,681 games), "steam" (2,990) and
 * "achievements" (1,903) describe a storefront, not a game. The rare ones —
 * "time-loop", "immersive-sim" — are what actually make two games alike. It's
 * the same intuition as IDF: a term that appears everywhere discriminates
 * nothing.
 */

/**
 * Keywords used by more than this many games are ignored. 500 keeps 5,091 of
 * 7,262 keywords and cuts candidate pairs from 149M to 35M.
 */
const MAX_KEYWORD_FREQUENCY = 500

/** Rows kept per game. The UI shows at most a dozen. */
const NEIGHBOURS_PER_GAME = 20

/** Weight added when two games also share a genre. */
const GENRE_BONUS = 0.15

/**
 * A single shared keyword is a coincidence, not a resemblance. Requiring two
 * removes the largest source of noise — 19% of stored pairs overlapped on
 * exactly one keyword.
 */
const MIN_SHARED_KEYWORDS = 2

/**
 * Smoothing added to both tag counts before normalising.
 *
 * Plain cosine normalisation divides by sqrt(tags_a * tags_b), which rewards
 * having *few* tags: a game with one keyword that happens to match scores
 * 1/sqrt(18*1) = 0.236, while Half-Life 2: Episode Two — sharing six keywords
 * with Portal 2 out of its 84 — scores 6/sqrt(18*84) = 0.154 and loses. That's
 * how "Arkista's Ring" ended up as the top match for Portal 2.
 *
 * Adding a constant to each count damps the small-denominator effect without
 * abandoning normalisation, the same trick as the Bayesian rating prior.
 */
const TAG_COUNT_SMOOTHING = 10

async function main() {
  const started = Date.now()
  console.log('Rebuilding game_similarity…')

  const [{ kept }] = (await db.execute<{ kept: number }>(sql`
    SELECT count(*)::int AS kept
    FROM (
      SELECT keyword_id FROM game_keywords
      GROUP BY keyword_id HAVING count(*) <= ${MAX_KEYWORD_FREQUENCY}
    ) rare
  `)) as unknown as { kept: number }[]
  console.log(`  using ${kept.toLocaleString()} keywords below the frequency cap`)

  await db.transaction(async (tx) => {
    /*
     * One transaction for two reasons: SET LOCAL only takes effect inside one,
     * and it keeps every statement on the same pooled connection. The pair
     * aggregation is the entire cost of this job and spills to disk at the
     * default work_mem.
     */
    await tx.execute(sql`SET LOCAL work_mem = '256MB'`)
    await tx.execute(sql`TRUNCATE game_similarity`)

    await tx.execute(sql`
    INSERT INTO game_similarity (game_id, similar_game_id, score)
    WITH rare AS (
      SELECT keyword_id
      FROM game_keywords
      GROUP BY keyword_id
      HAVING count(*) <= ${MAX_KEYWORD_FREQUENCY}
    ),
    tag_counts AS (
      SELECT gk.game_id, count(*)::real AS n
      FROM game_keywords gk
      JOIN rare r ON r.keyword_id = gk.keyword_id
      GROUP BY gk.game_id
    ),
    candidates AS (
      SELECT a.game_id AS game_id, b.game_id AS similar_game_id, count(*)::real AS shared
      FROM game_keywords a
      JOIN rare r ON r.keyword_id = a.keyword_id
      JOIN game_keywords b
        ON b.keyword_id = a.keyword_id
       AND b.game_id <> a.game_id
      GROUP BY a.game_id, b.game_id
      HAVING count(*) >= ${MIN_SHARED_KEYWORDS}
    ),
    scored AS (
      SELECT
        c.game_id,
        c.similar_game_id,
        /*
         * Smoothed cosine-style normalisation. The division stops a game
         * tagged with fifty keywords looking similar to everything simply by
         * having more chances to overlap; the smoothing constant stops the
         * opposite failure, where a game with almost no tags wins on a single
         * lucky match. See TAG_COUNT_SMOOTHING.
         */
        c.shared / sqrt((ta.n + ${TAG_COUNT_SMOOTHING}) * (tb.n + ${TAG_COUNT_SMOOTHING}))
          + CASE WHEN ga.genre_ids && gb.genre_ids THEN ${GENRE_BONUS}::real ELSE 0 END
          AS score
      FROM candidates c
      JOIN tag_counts ta ON ta.game_id = c.game_id
      JOIN tag_counts tb ON tb.game_id = c.similar_game_id
      JOIN games ga ON ga.id = c.game_id
      JOIN games gb ON gb.id = c.similar_game_id
    ),
    ranked AS (
      SELECT game_id, similar_game_id, score,
             row_number() OVER (PARTITION BY game_id ORDER BY score DESC, similar_game_id) AS rn
      FROM scored
    )
    SELECT game_id, similar_game_id, score
    FROM ranked
    WHERE rn <= ${NEIGHBOURS_PER_GAME}
  `)
  })

  await db.execute(sql`ANALYZE game_similarity`)

  const [stats] = (await db.execute<{ rows: number; games: number }>(sql`
    SELECT count(*)::int AS rows, count(DISTINCT game_id)::int AS games
    FROM game_similarity
  `)) as unknown as { rows: number; games: number }[]

  console.log(
    `Done: ${stats.rows.toLocaleString()} rows for ${stats.games.toLocaleString()} games ` +
      `in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  )
}

main()
  .catch((error) => {
    console.error('\nSimilarity rebuild failed:', error)
    process.exitCode = 1
  })
  .finally(closeDb)
