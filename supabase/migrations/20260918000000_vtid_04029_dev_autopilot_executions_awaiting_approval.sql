-- VTID-04029 (operator agent W4e): a Dev Autopilot execution can now stop
-- after pushing its branch and wait for a human Approve/Reject on the diff
-- before any pull request is opened (gap analysis §4.6, the commit-tier /
-- maker-checker shape). The row's status while it waits is
-- 'awaiting_approval'; the branch, head sha, PR title/body and a bounded
-- diff preview live under metadata.pending_approval.
--
-- Approve  → POST /api/v1/dev-autopilot/executions/:id/approve opens the PR
--            and the row moves to 'ci' exactly as an auto-opened PR would.
-- Reject   → POST /api/v1/dev-autopilot/executions/:id/reject deletes the
--            remote branch and the row moves to 'cancelled' (metadata.rejected).
--
-- Widens the status CHECK constraint only; no column change. Idempotent.
-- The gateway only writes this status when the agent executor was told to
-- hold (row metadata.require_approval or DEV_AUTOPILOT_PR_APPROVAL_REQUIRED),
-- so applying this migration changes nothing on its own.

ALTER TABLE public.dev_autopilot_executions
  DROP CONSTRAINT IF EXISTS dev_autopilot_executions_status_check;

ALTER TABLE public.dev_autopilot_executions
  ADD CONSTRAINT dev_autopilot_executions_status_check
  CHECK (status IN (
    'queued',
    'cooling',
    'cancelled',
    'running',
    'awaiting_approval',
    'ci',
    'merging',
    'deploying',
    'verifying',
    'completed',
    'failed',
    'reverted',
    'self_healed',
    'failed_escalated',
    'auto_archived'
  ));

COMMENT ON CONSTRAINT dev_autopilot_executions_status_check ON public.dev_autopilot_executions IS
  'VTID-04029: adds awaiting_approval — branch pushed, PR not opened, waiting for a human Approve/Reject on the stored diff preview.';
