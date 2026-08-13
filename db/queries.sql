-- ============================================================================
-- The two queries the schema exists to make fast.
-- These are the ones to benchmark and put EXPLAIN ANALYZE output for in the
-- README — they're what an interviewer will ask you to walk through.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Search: ranked full-text, with a trigram fallback for typos
--
-- Two strategies unioned:
--   a) tsvector match  — real words, weighted (title > alt titles > summary)
--   b) trigram similarity — catches "skyrm", "doom eternl", "faster then light"
--      and other things FTS refuses to match at all
--
-- The trigram branch is deliberately gated behind a similarity threshold and
-- ranked below every FTS hit, so it only surfaces when the exact search is thin.
--
-- NOTE: word_similarity (<%) not similarity (%). similarity() divides by the
-- length of the whole string, so a short query against a long title scores
-- below any usable threshold — "skyrm" vs "The Elder Scrolls V: Skyrim" is
-- 0.14, under the 0.3 default, i.e. no match at all. word_similarity compares
-- the query against the best-matching word sequence inside the title instead,
-- and scores the same pair at 0.67. Both operators use the same GIN index.
--
-- NOTE: the query is parsed with BOTH dictionaries and OR'd. Titles are indexed
-- with 'simple' and summaries with 'english', so parsing the query only as
-- 'english' silently fails against any title the stemmer alters — "bloodborne"
-- becomes the lexeme 'bloodborn', which never matches the 'bloodborne' token in
-- the title. Bloodborne was unfindable by name; only its editions ranked,
-- because their English-stemmed summaries happen to mention it.
-- ---------------------------------------------------------------------------

WITH q AS (
  SELECT
    websearch_to_tsquery('simple',  $1)
    || websearch_to_tsquery('english', $1) AS tsq,
    $1::text                               AS raw
),
fts AS (
  -- The CASE is what makes "search for X returns X" a property of the query
  -- rather than a coincidence. ts_rank sums term frequencies, so an edition
  -- that repeats the name across its alternate titles outranks the game itself.
  SELECT
    g.id,
    ts_rank(g.search_vector, q.tsq) * 10
    + CASE
        WHEN lower(g.name) = lower(q.raw)               THEN 100
        WHEN lower(g.name) LIKE lower(q.raw) || '%'     THEN 50
        ELSE 0
      END AS score
  FROM games g, q
  WHERE g.search_vector @@ q.tsq          -- games_search_idx (GIN)
),
fuzzy AS (
  SELECT
    g.id,
    word_similarity(q.raw, g.name) AS score
  FROM games g, q
  WHERE q.raw <% g.name                   -- games_name_trgm_idx (GIN)
)
SELECT
  g.id,
  g.slug,
  g.name,
  g.cover_url,
  g.first_release_date,
  g.igdb_rating,
  max(m.score) AS score
FROM (SELECT * FROM fts UNION ALL SELECT * FROM fuzzy) m
JOIN games g ON g.id = m.id
GROUP BY g.id
-- Popularity as a tiebreaker: two equally-relevant titles should not come back
-- in arbitrary heap order.
ORDER BY max(m.score) DESC, g.igdb_rating_count DESC
LIMIT 20;


-- ---------------------------------------------------------------------------
-- 2. Faceted browse: multi-genre + multi-platform + year range
--
-- The array columns turn what would be two joins, a GROUP BY and a HAVING
-- count(*) = n into a single GIN containment check. Compare the plan against
-- the normalized version — that comparison is a good README section.
--
--   $1 = genre ids    (smallint[], '{}' for "any")
--   $2 = platform ids (smallint[], '{}' for "any")
-- ---------------------------------------------------------------------------

SELECT
  g.id, g.slug, g.name, g.cover_url, g.first_release_date, g.igdb_rating,
  s.library_count
FROM games g
LEFT JOIN game_stats s ON s.game_id = g.id
WHERE ($1::smallint[] = '{}' OR g.genre_ids    @> $1)
  AND ($2::smallint[] = '{}' OR g.platform_ids @> $2)
  AND g.first_release_date BETWEEN $3 AND $4
  AND g.category = 'main_game'
  AND g.igdb_rating_count >= 50
ORDER BY g.igdb_rating DESC NULLS LAST
LIMIT 40;


-- ---------------------------------------------------------------------------
-- 3. The nightly similarity job — "games like this one"
--
-- Weighted overlap of keywords, genres and themes, normalized so that games
-- with hundreds of tags don't dominate every result (that's the /sqrt term —
-- it's cosine similarity in disguise).
--
-- Run as a batch INSERT into game_similarity, keeping the top 20 per game.
-- ---------------------------------------------------------------------------

INSERT INTO game_similarity (game_id, similar_game_id, score)
WITH shared AS (
  SELECT
    a.game_id      AS game_id,
    b.game_id      AS similar_game_id,
    -- Keywords are specific ("time-loop", "immersive-sim") so they carry more
    -- signal than a genre both games happen to share with 8,000 others.
    count(*) * 3.0 AS weight
  FROM game_keywords a
  JOIN game_keywords b ON b.keyword_id = a.keyword_id AND b.game_id <> a.game_id
  GROUP BY a.game_id, b.game_id

  UNION ALL

  SELECT a.game_id, b.game_id, count(*) * 1.0
  FROM game_genres a
  JOIN game_genres b ON b.genre_id = a.genre_id AND b.game_id <> a.game_id
  GROUP BY a.game_id, b.game_id
),
-- Both tag sources, so a game with genres but no keywords still gets a
-- denominator instead of silently dropping out of the join.
tag_counts AS (
  SELECT game_id, count(*) AS n FROM (
    SELECT game_id FROM game_keywords
    UNION ALL
    SELECT game_id FROM game_genres
  ) t GROUP BY game_id
),
scored AS (
  SELECT
    s.game_id,
    s.similar_game_id,
    sum(s.weight) / sqrt(ga.n * gb.n) AS score,
    row_number() OVER (
      PARTITION BY s.game_id
      ORDER BY sum(s.weight) / sqrt(ga.n * gb.n) DESC
    ) AS rn
  FROM shared s
  JOIN tag_counts ga ON ga.game_id = s.game_id
  JOIN tag_counts gb ON gb.game_id = s.similar_game_id
  GROUP BY s.game_id, s.similar_game_id, ga.n, gb.n
)
SELECT game_id, similar_game_id, score
FROM scored
WHERE rn <= 20
ON CONFLICT (game_id, similar_game_id) DO UPDATE SET score = EXCLUDED.score;


-- ---------------------------------------------------------------------------
-- 4. Player-count trend — window functions over the partitioned table
--
-- 7-day moving average plus week-over-week change. Only touches the partitions
-- covering the requested range.
-- ---------------------------------------------------------------------------

SELECT
  date_trunc('day', recorded_at) AS day,
  max(players)                   AS peak,
  avg(max(players)) OVER (
    ORDER BY date_trunc('day', recorded_at)
    ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
  ) AS peak_7d_avg,
  max(players) - lag(max(players), 7) OVER (
    ORDER BY date_trunc('day', recorded_at)
  ) AS wow_change
FROM player_counts
WHERE game_id = $1
  AND recorded_at >= now() - interval '90 days'
GROUP BY 1
ORDER BY 1;
