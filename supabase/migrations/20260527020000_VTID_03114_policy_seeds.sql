-- Phase B.2 (decision-contract refactor) — seed values for B.1 tables.
--
-- VTID-03114. Populates `decision_policy` + `policy_render_block`
-- with the global defaults that the Phase B.4 vertical proof
-- (greeting block in live-system-instruction.ts) will consume.
--
-- Phase B.2 ships data only. No app code reads these rows yet —
-- the resolver lands in Phase B.3 and the consumer in Phase B.4.
--
-- Idempotent: every INSERT is guarded by `WHERE NOT EXISTS` against
-- the same (key, tenant, version, language). Safe to re-run.
--
-- Seed values are byte-identical to the constants currently emitted
-- by `services/gateway/src/orb/live/instruction/live-system-instruction.ts`
-- at the time of writing (post-PR #2273, pre-resolver). Two embedded
-- placeholder tokens survive into the seeded text:
--
--   {{greeting_time_of_day}}   -- replaced by 'morning' | 'afternoon'
--                                 | 'evening' | 'day' at render time
--   {{short_gap_phrase_menu}}  -- replaced by the locale-specific
--                                 short-gap phrase block at render time
--
-- B.4 owns the substitution. B.2 only stores the template strings.
-- Non-English render-block rows are seeded with the English template
-- and `notes='seeded from en; awaiting translation'` per the Phase B
-- brief (`docs/decision-contract/phase-b-brief.md`). Translations
-- graduate through a later content-only PR.

-- ===========================================================
-- decision_policy seeds (5 rows, global defaults, version=1)
-- ===========================================================
-- All five describe the session-recency bucket thresholds that
-- `describeTimeSince()` uses today. Sources cited in `notes`.

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'session.recency_bucket.reconnect_max_seconds', NULL, 1, '120'::jsonb, 'seed',
       'live-system-instruction.ts:72 (diffSec < 120 → reconnect bucket)'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'session.recency_bucket.reconnect_max_seconds'
    AND tenant_id IS NULL AND version = 1
);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'session.recency_bucket.recent_max_minutes', NULL, 1, '15'::jsonb, 'seed',
       'live-system-instruction.ts:75 (diffMin < 15 → recent bucket)'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'session.recency_bucket.recent_max_minutes'
    AND tenant_id IS NULL AND version = 1
);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'session.recency_bucket.same_day_max_hours', NULL, 1, '8'::jsonb, 'seed',
       'live-system-instruction.ts:78 (diffHour < 8 → same_day bucket)'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'session.recency_bucket.same_day_max_hours'
    AND tenant_id IS NULL AND version = 1
);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'session.recency_bucket.today_max_hours', NULL, 1, '24'::jsonb, 'seed',
       'live-system-instruction.ts:85 (diffHour < 24 → today bucket)'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'session.recency_bucket.today_max_hours'
    AND tenant_id IS NULL AND version = 1
);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'session.recency_bucket.week_max_days', NULL, 1, '7'::jsonb, 'seed',
       'live-system-instruction.ts:91 (diffDay < 7 → week bucket; >= 7 → long)'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'session.recency_bucket.week_max_days'
    AND tenant_id IS NULL AND version = 1
);

-- ===========================================================
-- policy_render_block seeds (64 rows = 8 buckets × 8 languages)
-- ===========================================================
-- Templates first (English authoritative). Then a single fan-out
-- INSERT multiplies by language, attaching the translation-pending
-- note for every non-`en` row.

WITH bucket_templates AS (
  SELECT * FROM (VALUES
    -- bucket=reconnect (no interpolations — verbatim text)
    ('greeting.bucket.reconnect',
$$- BUCKET = reconnect (transparent server-side resume — the user did NOT perceive any pause).
  • DO NOT speak. DO NOT greet. DO NOT acknowledge any "interruption", "reconnection", "resume", "where were we", "I'm back", "I'm listening", "picking up", or anything similar. Saying any of these creates a perceived apology that the user reads as a bug.
  • Wait for the user to speak. Your next message must be a direct response to the user's next utterance — nothing else.
  • If the user says nothing, you say nothing. Silence is correct here.$$),

    -- bucket=recent (short-gap menu placeholder)
    ('greeting.bucket.recent',
$$- BUCKET = recent (2–15 min since last session).
  • Do NOT use a formal greeting. NO "Hello <name>!", NO "Hi there!", NO self-introduction. NO user name.
  • Open with ONE single short phrase. NEVER use two-part sentences joined by dashes or commas.
{{short_gap_phrase_menu}}
  • Max ONE short phrase. Warm but direct.$$),

    -- bucket=same_day (short-gap menu placeholder)
    ('greeting.bucket.same_day',
$$- BUCKET = same_day (15 min – 8 h since last session).
  • Light re-engagement. NOT a formal greeting. No user name. NEVER "Hello <name>!" as if you've never met.
  • Open with ONE single short phrase. NEVER use two-part sentences joined by dashes or commas.
{{short_gap_phrase_menu}}
  • Max ONE short phrase. Warm and direct.$$),

    -- bucket=today (greeting_time_of_day placeholder)
    ('greeting.bucket.today',
$$- BUCKET = today (8–24 h since last session — this is a NEW-DAY greeting).
  • ALWAYS open with "Good {{greeting_time_of_day}}, [Name]." using the user's name from memory context.
  • If no name is available in memory, just say "Good {{greeting_time_of_day}}."
  • LEGACY-FALLBACK ONLY (use the brain context's candidate when available).
  • Example follow-up if no candidate exists (pick ONE or skip):
      "What's on your mind today?"
      "Where would you like to focus today?"
  • Max TWO short sentences total: the time-of-day greeting + optionally one question.$$),

    -- bucket=yesterday (greeting_time_of_day placeholder)
    ('greeting.bucket.yesterday',
$$- BUCKET = yesterday (this is a NEW-DAY greeting).
  • ALWAYS open with "Good {{greeting_time_of_day}}, [Name]." using the user's name from memory context.
  • If no name is available in memory, just say "Good {{greeting_time_of_day}}."
  • LEGACY-FALLBACK ONLY (use the brain context's candidate when available).
  • Example follow-up if no candidate exists (pick ONE or skip):
      "What would you like to explore today?"
      "Picking up where we left off?"
  • Max TWO short sentences total: the time-of-day greeting + optionally one question.$$),

    -- bucket=week (greeting_time_of_day placeholder)
    ('greeting.bucket.week',
$$- BUCKET = week (2–7 days since last session — this is a NEW-DAY greeting).
  • ALWAYS open with "Good {{greeting_time_of_day}}, [Name]." using the user's name from memory context.
  • If no name is available in memory, just say "Good {{greeting_time_of_day}}."
  • LEGACY-FALLBACK ONLY (use the brain context's candidate when available).
  • Example follow-up if no candidate exists (pick ONE or skip):
      "Good to hear from you again — what's been on your mind?"
      "What would you like to explore today?"
  • Max TWO short sentences total: the time-of-day greeting + optionally one question.$$),

    -- bucket=long (greeting_time_of_day placeholder)
    ('greeting.bucket.long',
$$- BUCKET = long (> 7 days since last session — this is a NEW-DAY greeting).
  • ALWAYS open with "Good {{greeting_time_of_day}}, [Name]." using the user's name from memory context.
  • If no name is available in memory, just say "Good {{greeting_time_of_day}}."
  • LEGACY-FALLBACK ONLY (use the brain context's candidate when available — for >7-day absences the candidate should explicitly acknowledge the gap).
  • Example follow-up if no candidate exists (pick ONE or skip):
      "It's been a few days — happy you're back. What's been on your mind?"
      "What would you like to focus on today?"
  • Max TWO short sentences total: the time-of-day greeting + optionally one question.$$),

    -- bucket=first (greeting_time_of_day placeholder)
    ('greeting.bucket.first',
$$- BUCKET = first (telemetry lookup found no prior session — usually treat as RETURNING with NEW-DAY greeting).
  • ALWAYS open with "Good {{greeting_time_of_day}}, [Name]." using the user's name from memory context.
  • If no name is available in memory, just say "Good {{greeting_time_of_day}}."
  • EXCEPTION: when the brain context's USER AWARENESS shows tenure.stage="day0", the user is genuinely new. Use the FULL INTRODUCTION shape from the brain context's OPENING SHAPE MATRIX — that overrides this fallback.
  • LEGACY-FALLBACK ONLY (use the brain context's candidate when available).
  • Example follow-up if no candidate exists (pick ONE or skip):
      "What's on your mind today?"
      "Where would you like to focus today?"
  • Max TWO short sentences total: the time-of-day greeting + optionally one question.$$)
  ) AS t(block_key, content)
),
languages AS (
  SELECT * FROM (VALUES
    ('en'), ('de'), ('fr'), ('es'), ('ar'), ('zh'), ('ru'), ('sr')
  ) AS l(language)
),
seed_rows AS (
  SELECT
    bt.block_key,
    l.language,
    bt.content,
    CASE
      WHEN l.language = 'en' THEN 'live-system-instruction.ts switch(bucket) at lines ~226-312'
      ELSE 'seeded from en; awaiting translation'
    END AS notes
  FROM bucket_templates bt
  CROSS JOIN languages l
)
INSERT INTO policy_render_block (block_key, language, tenant_id, version, content, source, notes)
SELECT
  s.block_key,
  s.language,
  NULL,
  1,
  s.content,
  'seed',
  s.notes
FROM seed_rows s
WHERE NOT EXISTS (
  SELECT 1 FROM policy_render_block p
  WHERE p.block_key = s.block_key
    AND p.language = s.language
    AND p.tenant_id IS NULL
    AND p.version = 1
);

-- ===========================================================
-- Sanity post-conditions (logged, not enforced)
-- ===========================================================
-- A psql interactive run will see these via NOTICE. CI does too.

DO $$
DECLARE
  policy_count INTEGER;
  block_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO policy_count
    FROM decision_policy
    WHERE source = 'seed' AND tenant_id IS NULL;
  SELECT COUNT(*) INTO block_count
    FROM policy_render_block
    WHERE source = 'seed' AND tenant_id IS NULL;
  RAISE NOTICE 'VTID-03114 seed counts: decision_policy=%, policy_render_block=%',
    policy_count, block_count;
  IF policy_count < 5 THEN
    RAISE WARNING 'decision_policy seed count below expected 5: %', policy_count;
  END IF;
  IF block_count < 64 THEN
    RAISE WARNING 'policy_render_block seed count below expected 64: %', block_count;
  END IF;
END $$;
