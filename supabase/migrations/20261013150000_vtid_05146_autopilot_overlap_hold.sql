-- VTID-05146 (Dev Autopilot autonomy, Phase C): no collisions with people.
--
-- 1. dev_autopilot_executions.status gains 'held_overlap': an execution whose
--    plan (before the claim) or whose PR (before the auto-merge) touches a file
--    an open pull request also changes waits, instead of running or merging.
--    The watcher re-checks it every tick and releases it when the blocking PRs
--    merge or close; after overlap_hold_max_hours it ends as failed
--    (overlap_hold_timeout). Never merged on a timeout.
-- 2. The one-in-flight-execution-per-finding index covers 'held_overlap' too:
--    a held execution is still in flight, so a second one for the same finding
--    must not start beside it.
-- 3. dev_autopilot_config.frozen_scope (glob list, temporary, set while people
--    work an area): a plan touching it is never approved and an open autopilot
--    PR touching it is never merged. deny_scope stays the permanent list.
-- 4. dev_autopilot_config.overlap_hold_max_hours (default 72, 1..720).
--
-- Additive and idempotent. Inert while the kill switch is armed (it is today):
-- nothing claims or merges, so no row can reach 'held_overlap'.

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
    'held_overlap',
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
  'VTID-05146: adds held_overlap — the plan or the PR overlaps an open pull request (or the PR touches frozen_scope); waits for the blocking PRs, never merged on a timeout.';

DROP INDEX IF EXISTS public.dev_autopilot_executions_finding_inflight_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS dev_autopilot_executions_finding_inflight_uniq
  ON public.dev_autopilot_executions (finding_id)
  WHERE status IN (
    'cooling',
    'running',
    'held_overlap',
    'ci',
    'merging',
    'deploying',
    'verifying'
  );

COMMENT ON INDEX public.dev_autopilot_executions_finding_inflight_uniq IS
  'VTID-AUTOPILOT-RACE / VTID-05146 — one in-flight execution per finding; held_overlap counts as in flight.';

ALTER TABLE public.dev_autopilot_config
  ADD COLUMN IF NOT EXISTS frozen_scope jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.dev_autopilot_config
  ADD COLUMN IF NOT EXISTS overlap_hold_max_hours integer NOT NULL DEFAULT 72;

ALTER TABLE public.dev_autopilot_config
  DROP CONSTRAINT IF EXISTS dev_autopilot_config_overlap_hold_max_hours_check;

ALTER TABLE public.dev_autopilot_config
  ADD CONSTRAINT dev_autopilot_config_overlap_hold_max_hours_check
  CHECK (overlap_hold_max_hours BETWEEN 1 AND 720);

COMMENT ON COLUMN public.dev_autopilot_config.frozen_scope IS
  'VTID-05146: temporary never-touch globs while people work an area. Checked at plan approval and before an autopilot PR merges. deny_scope is the permanent list.';
COMMENT ON COLUMN public.dev_autopilot_config.overlap_hold_max_hours IS
  'VTID-05146: a held_overlap execution older than this ends as failed (overlap_hold_timeout); its PR is closed with a comment and the finding returns to the queue.';

-- Initial value at rollout (plan C2): the Command Hub frontend stays frozen
-- while the app.js split (VTID-05072/05073) is open. Set only when the column
-- still holds its default, so a later edit is never overwritten by a re-run.
UPDATE public.dev_autopilot_config
   SET frozen_scope = '["services/gateway/src/frontend/command-hub/**"]'::jsonb
 WHERE id = 1 AND frozen_scope = '[]'::jsonb;
