-- VTID-02702: Rollback feature for autopilot-resolved feedback tickets.
--
-- A ticket auto-resolved by the dev autopilot gets a "Rollback" button on
-- its drawer for 3 days after `resolved_at`. Pressing Rollback creates a
-- revert PR via the GitHub API, which the existing watcher auto-merges and
-- ships through EXEC-DEPLOY. The original ticket flips back to `reopened`
-- so a fresh autopilot attempt can run with refined supervisor instructions.
--
-- After 72 hours, the frontend hides the button (computed from `resolved_at`,
-- not stored). The change becomes "kept."
--
-- The 3-day window is enforced server-side in the rollback endpoint, NOT
-- via a stored expiry timestamp — keeps the schema simple and lets us tune
-- the window via env var without a migration.

ALTER TABLE public.feedback_tickets
  ADD COLUMN IF NOT EXISTS rolled_back_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rollback_pr_url TEXT,
  ADD COLUMN IF NOT EXISTS rolled_back_by UUID REFERENCES auth.users(id);

COMMENT ON COLUMN public.feedback_tickets.rolled_back_at IS
  'VTID-02702: timestamp when a tenant admin pressed Rollback on this ticket. '
  'Set by POST /admin/tenants/:tenantId/tickets/:id/rollback. '
  'Frontend filters "Rolled back" tab on this column being non-null.';

COMMENT ON COLUMN public.feedback_tickets.rollback_pr_url IS
  'VTID-02702: URL of the revert PR created by the rollback flow. '
  'The watcher auto-merges this PR through the same path as forward PRs.';

COMMENT ON COLUMN public.feedback_tickets.rolled_back_by IS
  'VTID-02702: user_id of the supervisor who pressed Rollback.';

-- Helpful index for the "Rolled back" filter in the inbox.
CREATE INDEX IF NOT EXISTS idx_feedback_tickets_rolled_back
  ON public.feedback_tickets (rolled_back_at)
  WHERE rolled_back_at IS NOT NULL;
