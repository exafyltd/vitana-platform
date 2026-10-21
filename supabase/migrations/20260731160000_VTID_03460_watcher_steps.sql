-- =============================================================================
-- VTID-03460 — Watcher Phase 1: lifecycle timeline
-- =============================================================================
-- Plan: docs/WATCHER-AGENT-PLAN.md (VTID-03454), Phase 1.
--
-- The Watcher observes every step of the development lifecycle and records
-- what actually happened. Today that history is scattered and lossy:
--
--   * dev_autopilot_executions holds CURRENT status only — the transition
--     history that produced it is gone.
--   * oasis_events holds transitions, but mixed with everything else in the
--     platform and keyed by topic rather than by unit of work.
--   * Claude Code sessions leave no trace at all. VTID-03419's doc-update
--     step was lost exactly this way (see CLAUDE.md changelog 2026-07-29).
--
-- watcher_steps is the normalized join of all three: one row per observed
-- lifecycle step, keyed by the unit of work it belongs to.
--
-- PHASE 1 IS READ-ONLY DOWNSTREAM. Nothing consumes this table yet. Phase 2
-- (watcher_lessons / watcher_rules) distills it; Phase 3+ injects reminders.
--
-- The observer that writes these rows emits ZERO OASIS events. Its scan is a
-- poll, and CLAUDE.md §6 is explicit: polling ≠ progress, heartbeat ≠ event.
-- Only a real decision (Phase 3's "a reminder was raised") is event-worthy.
--
-- No RLS policies beyond ENABLE — the gateway reads/writes via
-- SUPABASE_SERVICE_ROLE, which bypasses RLS. anon/authenticated get nothing
-- by default on an RLS-enabled table with no policies. Same posture as
-- dev_autopilot_prompt_learnings.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- watcher_steps — the timeline
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.watcher_steps (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What unit of work this step belongs to. A single VTID may span several
  -- executions and PRs, so work_unit is deliberately polymorphic rather than
  -- a FK — some sources (sessions) have no row anywhere else to point at.
  work_unit_kind    TEXT        NOT NULL
    CHECK (work_unit_kind IN ('vtid', 'execution', 'pr', 'session')),
  work_unit_id      TEXT        NOT NULL,

  -- Denormalized because "show me everything that happened for VTID-XXXXX"
  -- is the query this table exists to answer. NULL when a step genuinely has
  -- no VTID (an ungoverned session, which is itself worth being able to find).
  vtid              TEXT,

  -- The lifecycle step. Ordered roughly by when it occurs, but the observer
  -- never assumes ordering — steps can arrive late, out of order, or not at
  -- all, and a gap is a finding rather than an error.
  step              TEXT        NOT NULL
    CHECK (step IN (
      'allocated',    -- VTID minted in the ledger
      'planned',      -- plan/spec produced
      'queued',       -- awaiting a concurrency slot
      'running',      -- agent editing / pushing
      'validated',    -- pre-PR validation (tsc, jest, parse)
      'pr_opened',
      'ci',
      'merged',
      'deploying',
      'verified',     -- post-deploy verification window closed clean
      'completed',
      'failed',
      'reverted',
      'escalated',
      'doc_updated',  -- the step VTID-03419 silently skipped
      'terminalized'  -- is_terminal=true written to the ledger
    )),

  outcome           TEXT        NOT NULL DEFAULT 'unknown'
    CHECK (outcome IN ('success', 'failure', 'skipped', 'unknown')),

  actor             TEXT        NOT NULL
    CHECK (actor IN ('autopilot', 'worker-runner', 'claude-session', 'human', 'ci', 'unknown')),

  -- Free-form provenance: event ids, PR url, commit sha, error excerpt.
  -- Deliberately not a fixed shape — each source contributes what it has,
  -- and Phase 2's distiller reads it opportunistically.
  evidence          JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- Which observer source produced this row, e.g. 'oasis_events',
  -- 'dev_autopilot_executions', 'session_api'. Lets us audit coverage per
  -- source and re-derive a single source's rows without touching the others.
  source            TEXT        NOT NULL,

  -- Stable per-source identity for the observed thing. Combined with source
  -- and step, this is what makes the observer idempotent across restarts and
  -- overlapping scan windows — re-reading the same event never duplicates.
  source_ref        TEXT        NOT NULL,

  observed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (source, source_ref, step)
);

-- "Everything that happened to this unit of work, in order" — the primary read.
CREATE INDEX IF NOT EXISTS idx_watcher_steps_work_unit
  ON public.watcher_steps (work_unit_id, observed_at DESC);

-- "Everything that happened to this VTID" across executions/PRs/sessions.
CREATE INDEX IF NOT EXISTS idx_watcher_steps_vtid
  ON public.watcher_steps (vtid, observed_at DESC)
  WHERE vtid IS NOT NULL;

-- Phase 2 reads failures by step to distil lessons; keep that path cheap.
CREATE INDEX IF NOT EXISTS idx_watcher_steps_step_recent
  ON public.watcher_steps (step, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_watcher_steps_failures
  ON public.watcher_steps (observed_at DESC)
  WHERE outcome = 'failure';

ALTER TABLE public.watcher_steps ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.watcher_steps IS 'VTID-03460 (Watcher Phase 1): normalized development-lifecycle timeline. One row per observed step. Written by the gateway observer only; the observer emits no OASIS events (CLAUDE.md section 6: polling is not progress).';

-- -----------------------------------------------------------------------------
-- watcher_observer_state — scan cursors
-- -----------------------------------------------------------------------------
-- One row per observer source. The cursor is a timestamp rather than an id
-- because both source tables are append-ordered by created_at/updated_at and
-- neither exposes a monotonic sequence we can rely on.
--
-- The observer deliberately re-scans a small overlap window behind the cursor
-- (rows can land with a created_at slightly behind commit order), which is
-- safe precisely because of the UNIQUE (source, source_ref, step) constraint
-- above — replay is idempotent, so overlap costs a few wasted upserts and
-- never a duplicate row.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.watcher_observer_state (
  source            TEXT        PRIMARY KEY,
  cursor_at         TIMESTAMPTZ NOT NULL,
  last_run_at       TIMESTAMPTZ,
  last_error        TEXT,
  -- Rows written on the most recent successful tick. A source that scans
  -- but never writes is the signature of a broken normalizer, and that is
  -- exactly the "silently degraded" state CLAUDE.md ALWAYS rule 10 says must
  -- be visible rather than swallowed — /api/v1/watcher/health surfaces it.
  last_written      INTEGER     NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.watcher_observer_state ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.watcher_observer_state IS 'VTID-03460: per-source scan cursor for the Watcher observer. Overlap rescan is safe because watcher_steps is upserted on (source, source_ref, step).';
