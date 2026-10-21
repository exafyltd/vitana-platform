-- =============================================================================
-- Dev Autopilot — prompt-gap feedback loop (learnings table)
-- =============================================================================
-- When the worker's pre-PR validation fails (tsc red, jest red, parse
-- error) we currently throw the signal away once the retry budget is
-- exhausted. That means future plan/execute prompts keep repeating the
-- same class of mistake (wrong relative-import depth, picking `tests/`
-- over `test/`, referencing a module that doesn't exist, etc.).
--
-- This table gives us a place to record those failures and, at the next
-- planning/execution, inject a short "lessons from prior attempts" block
-- into the prompt so the autopilot can learn from its own mistakes.
--
-- Writes happen from services/gateway/src/services/dev-autopilot-execute.ts
-- after each runWorkerTask() returns. Reads happen from
-- services/gateway/src/services/dev-autopilot-planning.ts +
-- dev-autopilot-execute.ts when building the next prompt.
--
-- No RLS policies beyond ENABLE — the gateway reads/writes via the
-- SUPABASE_SERVICE_ROLE key which bypasses RLS anyway.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.dev_autopilot_prompt_learnings (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_type    TEXT        NOT NULL
    CHECK (pattern_type IN ('tsc_error','jest_failure','parse_error','out_of_scope','validation_other')),
  -- Normalized signature — shape depends on pattern_type. Examples:
  --   tsc_error:       'TS2307:cannot-find-module'
  --   jest_failure:    'jest:expect-toBe-mismatch'
  --   parse_error:     'parse:missing-PR_TITLE'
  pattern_key     TEXT        NOT NULL,
  -- First 500 chars of an actual occurrence, so a human reviewer can
  -- tell if the auto-derived pattern_key captured the real signal.
  example_message TEXT        NOT NULL,
  -- Source finding's scanner, used to scope retrieval (e.g. only pull
  -- missing-tests-scanner-v1 lessons when planning a missing-tests finding).
  scanner         TEXT,
  finding_id      UUID,
  execution_id    UUID,
  frequency       INTEGER     NOT NULL DEFAULT 1,
  -- Human-authored upgrade of the auto-derived pattern_key. When present,
  -- the prompt injector prefers this over the raw example_message.
  mitigation_note TEXT,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pattern_type, pattern_key, scanner)
);

CREATE INDEX IF NOT EXISTS idx_dev_autopilot_prompt_learnings_recent
  ON public.dev_autopilot_prompt_learnings (last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_dev_autopilot_prompt_learnings_by_scanner
  ON public.dev_autopilot_prompt_learnings (scanner, last_seen_at DESC)
  WHERE scanner IS NOT NULL;

ALTER TABLE public.dev_autopilot_prompt_learnings ENABLE ROW LEVEL SECURITY;

-- Service role is the only writer (gateway). No other policies needed —
-- anon/authenticated roles have zero access by default on an RLS-enabled
-- table without policies.
