-- =============================================================================
-- Dev Autopilot — auto-approve threshold columns
-- =============================================================================
-- The auto-merge pipeline (scan → plan → approve → cool → execute → CI →
-- merge → deploy) now runs end-to-end, but a human still has to click
-- Approve on each finding. These columns let operators opt-in to
-- unattended approval for low-risk, low-effort findings from trusted
-- scanners, while keeping the default behaviour identical (enabled=false).
--
-- The safety gate (evaluateSafetyGate) still runs on every auto-approved
-- finding — auto_approve only removes the human click, it does not bypass
-- allow_scope, deny_scope, or the file-count cap.
--
-- Rollout plan:
--   1. Deploy gateway with autoApproveTick() wired in but no-op (enabled=false).
--   2. Manually flip auto_approve_enabled=true in Supabase Studio.
--   3. Watch OASIS for dev_autopilot.execution.auto_approved events.
--   4. If misbehaves, flip back — no code change needed.
-- =============================================================================

ALTER TABLE public.dev_autopilot_config
  ADD COLUMN IF NOT EXISTS auto_approve_enabled    BOOLEAN   NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_approve_max_effort INTEGER   NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS auto_approve_risk_classes TEXT[]  NOT NULL
    DEFAULT ARRAY['low','medium']::text[],
  ADD COLUMN IF NOT EXISTS auto_approve_scanners   TEXT[]    NOT NULL
    DEFAULT ARRAY['missing-tests-scanner-v1','safety-gap-scanner-v1']::text[];
