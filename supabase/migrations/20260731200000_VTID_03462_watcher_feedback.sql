-- =============================================================================
-- VTID-03462 — Watcher Phase 3: reminder feedback
-- =============================================================================
-- Plan: docs/WATCHER-AGENT-PLAN.md (VTID-03454) §3.4.
--
-- The feedback edge is the point of the whole design, not an afterthought.
-- A reminder store with no relevance signal degrades into noise within weeks:
-- lessons accumulate, none are ever retired, the block fills with things that
-- never mattered, and the worker learns to skim past it. At that point the
-- tokens are still being spent and the ONE reminder that would have helped is
-- lost in the pile.
--
-- So every injected reminder carries an id, and the consuming step reports
-- back what happened:
--
--   shown + mistake still occurred  -> confidence DOWN. The text is probably
--                                      too vague to act on; flag for rewrite.
--   shown + mistake absent          -> confidence UP (mild).
--   shown N times, never correlated -> auto-mute. It is costing prompt budget
--                                      for nothing.
--
-- Rules are NOT auto-muted. They are authored canon, and "nobody violated
-- this rule recently" is evidence the rule is working, not evidence it is
-- useless. Only learned lessons decay.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.watcher_reminder_feedback (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 'rule:<rule_key>' or 'lesson:<uuid>' — matches the reminder_id handed out
  -- by buildReminders(). Deliberately not a FK: a lesson can be deleted or a
  -- rule renamed, and losing the historical feedback would erase the evidence
  -- for why something was muted.
  reminder_id    TEXT        NOT NULL,
  kind           TEXT        NOT NULL CHECK (kind IN ('rule', 'lesson')),

  work_unit_id   TEXT,
  vtid           TEXT,
  stage          TEXT,

  outcome        TEXT        NOT NULL
    CHECK (outcome IN ('success', 'failure', 'unknown')),
  -- The signal that actually matters: was the reminder shown and the mistake
  -- made anyway?
  repeated_mistake BOOLEAN   NOT NULL DEFAULT FALSE,
  note           TEXT,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_watcher_feedback_reminder
  ON public.watcher_reminder_feedback (reminder_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_watcher_feedback_repeats
  ON public.watcher_reminder_feedback (reminder_id)
  WHERE repeated_mistake = TRUE;

ALTER TABLE public.watcher_reminder_feedback ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.watcher_reminder_feedback IS 'VTID-03462 (Watcher Phase 3): per-reminder relevance signal. Drives confidence and auto-mute on watcher_lessons. Rules are never auto-muted.';

-- -----------------------------------------------------------------------------
-- Shown-count bookkeeping on watcher_lessons
-- -----------------------------------------------------------------------------
-- Auto-mute needs a denominator. Without shown_count, "never correlated with a
-- mistake" is indistinguishable from "never actually injected", and a lesson
-- that has simply never been retrieved would be muted for the sin of not
-- having had the chance to help.
ALTER TABLE public.watcher_lessons
  ADD COLUMN IF NOT EXISTS shown_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.watcher_lessons
  ADD COLUMN IF NOT EXISTS helped_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.watcher_lessons
  ADD COLUMN IF NOT EXISTS ignored_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.watcher_lessons.shown_count IS 'VTID-03462: times injected. The denominator for auto-mute — without it, "never helped" and "never shown" look identical.';
COMMENT ON COLUMN public.watcher_lessons.ignored_count IS 'VTID-03462: times shown AND the mistake happened anyway. High values mean the text is too vague to act on, not that the lesson is wrong.';
