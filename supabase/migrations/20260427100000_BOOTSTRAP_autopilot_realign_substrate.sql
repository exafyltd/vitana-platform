-- =============================================================================
-- Autopilot Realign Phase 2 — substrate for the self-improving loop
-- =============================================================================
-- Three additive changes that together close the autonomy loop:
--
-- 1. dev_autopilot_outcomes table — every approve/auto-exec/reject/dismiss
--    decision lands here, plus the eventual exec outcome. This is the data
--    substrate a future autonomy-graduation policy reads to decide which
--    scanners get promoted to higher autonomy levels.
--
-- 2. Tighten existing dev_autopilot rows to match the conservative triage
--    rule that ships in the same release: auto_exec_eligible=TRUE only when
--    risk_class='low' AND impact_score>=5. Anything that doesn't pass flips
--    back to FALSE so it lands in the Pending Approvals popup, which is the
--    correct place to ask a human.
--
-- 3. No new status values — Phase 1 reused existing 'new' and the new
--    auto_exec_eligible boolean as the "needs approval vs auto-exec" axis.
--    Status stays the existing ladder for backward compatibility.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. dev_autopilot_outcomes — substrate for self-improvement
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.dev_autopilot_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  finding_id UUID NOT NULL REFERENCES public.autopilot_recommendations(id) ON DELETE CASCADE,
  scanner_name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('dev_autopilot', 'dev_autopilot_impact')),
  risk_class TEXT,
  impact_score INTEGER,
  effort_score INTEGER,

  -- The decision: how this finding left the queue.
  --   auto_exec — dispatcher picked it up because auto_exec_eligible=true
  --   approved  — human approved via the Pending Approvals popup
  --   rejected  — human rejected
  --   dismissed — human dismissed (snooze counts as transient, not an outcome)
  --   demoted   — dispatcher refused to auto-exec (e.g., destructive plan
  --               markers found at the last gate); flipped to FALSE and
  --               returned to the popup
  decision TEXT NOT NULL CHECK (decision IN ('auto_exec','approved','rejected','dismissed','demoted')),

  -- Set when a human is the approver/rejecter; NULL for auto_exec/demoted.
  approver_user_id UUID,

  -- VTID + execution outcome — set after approveAutoExecute() returns and the
  -- worker actually runs. exec_outcome remains NULL until the worker reports.
  vtid TEXT,
  exec_outcome TEXT CHECK (exec_outcome IN ('success','failure','rolled_back','timeout')),
  exec_completed_at TIMESTAMPTZ,

  -- Did the human edit the plan before approving? Tracks how often the AI's
  -- proposal needs human polish — important signal for autonomy graduation.
  human_modified_plan BOOLEAN DEFAULT FALSE,

  -- Free-text reason: rejection reason from human, or demotion reason from
  -- dispatcher (e.g., "DROP TABLE found in plan"). NULL otherwise.
  reason TEXT,

  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dev_autopilot_outcomes_finding
  ON public.dev_autopilot_outcomes (finding_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dev_autopilot_outcomes_scanner
  ON public.dev_autopilot_outcomes (scanner_name, decision, created_at DESC);

-- Used by the future graduation policy: "scanner X had N consecutive
-- successful auto_exec outcomes in the last window".
CREATE INDEX IF NOT EXISTS idx_dev_autopilot_outcomes_scanner_success
  ON public.dev_autopilot_outcomes (scanner_name, exec_outcome, created_at DESC)
  WHERE decision = 'auto_exec';

ALTER TABLE public.dev_autopilot_outcomes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dev_autopilot_outcomes_service_role ON public.dev_autopilot_outcomes;
CREATE POLICY dev_autopilot_outcomes_service_role
  ON public.dev_autopilot_outcomes FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS dev_autopilot_outcomes_authenticated_read ON public.dev_autopilot_outcomes;
CREATE POLICY dev_autopilot_outcomes_authenticated_read
  ON public.dev_autopilot_outcomes FOR SELECT
  TO authenticated
  USING (true);

GRANT SELECT, INSERT, UPDATE ON public.dev_autopilot_outcomes TO service_role;
GRANT SELECT ON public.dev_autopilot_outcomes TO authenticated;

COMMENT ON TABLE public.dev_autopilot_outcomes IS
  'BOOTSTRAP-AUTOPILOT-REALIGN: per-decision substrate for the dev autopilot self-improvement loop. One row per approve/auto-exec/reject/dismiss/demote decision; exec_outcome backfills when the worker reports.';

-- -----------------------------------------------------------------------------
-- 2. Tighten existing rows to match conservative triage rule
-- -----------------------------------------------------------------------------
-- Rule: auto_exec_eligible = (risk_class='low' AND impact_score >= 5).
-- The application code is being updated to use the same rule at synthesis
-- time. This UPDATE backfills existing rows so the popup gets the benefit
-- immediately rather than only for newly-scanned findings.
--
-- Rows that PREVIOUSLY had auto_exec_eligible=TRUE but no longer pass the
-- new rule flip back to FALSE — they will reappear in the Pending Approvals
-- popup, which is the correct place to ask a human. This is intentional:
-- the prior rule (risk!='high') was too loose and the user explicitly chose
-- the conservative path.

UPDATE public.autopilot_recommendations
SET auto_exec_eligible = (
      risk_class = 'low'
      AND COALESCE(impact_score, 0) >= 5
    ),
    updated_at = NOW()
WHERE source_type IN ('dev_autopilot', 'dev_autopilot_impact')
  AND status = 'new';

-- -----------------------------------------------------------------------------
-- Done
-- -----------------------------------------------------------------------------
