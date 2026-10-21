-- =============================================================================
-- Dev Autopilot — extend executions status to include 'auto_archived'
-- =============================================================================
-- The matching gateway PR adds an auto-archive watchdog for terminal-failure
-- rows older than AUTOPILOT_AUTO_ARCHIVE_DAYS (default 7). The current
-- status CHECK constraint (from 20260416100000_dev_autopilot.sql) only
-- allows: queued, cooling, cancelled, running, ci, merging, deploying,
-- verifying, completed, failed, reverted, self_healed, failed_escalated.
--
-- This migration:
--   1. Extends the constraint to allow 'auto_archived'.
--   2. One-shot archives every terminal-failure row already older than 7
--      days. PR #854 (deploying since Apr 23) and PR #798 (merging) +
--      anything else stuck from earlier runs get cleaned up immediately,
--      so the queue + Self-Healing UI start from a clean baseline.
--
-- Idempotent: re-running just no-ops on already-archived rows.
-- =============================================================================

-- Step 1: extend the constraint.
ALTER TABLE public.dev_autopilot_executions
  DROP CONSTRAINT IF EXISTS dev_autopilot_executions_status_check;

ALTER TABLE public.dev_autopilot_executions
  ADD CONSTRAINT dev_autopilot_executions_status_check
  CHECK (status IN (
    'queued',
    'cooling',
    'cancelled',
    'running',
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

-- Step 2: one-shot archive of pre-existing terminal-failure rows older
-- than 7 days. We don't archive 'reverted' rows that have a child still
-- in flight — those are the ACTIVE retry attempts, not stuck.
UPDATE public.dev_autopilot_executions parent
SET
  status = 'auto_archived',
  updated_at = NOW(),
  metadata = jsonb_set(
    COALESCE(parent.metadata, '{}'::jsonb),
    '{archived_reason}',
    to_jsonb('auto-archived after >7d in terminal-failure state (2026-04-25)'::text)
  )
WHERE parent.status IN ('failed', 'failed_escalated', 'cancelled')
  AND parent.updated_at < NOW() - INTERVAL '7 days';

-- 'reverted' rows are special — they're parents of active retries. Only
-- archive a reverted row if NO descendant is still in a non-terminal state.
UPDATE public.dev_autopilot_executions parent
SET
  status = 'auto_archived',
  updated_at = NOW(),
  metadata = jsonb_set(
    COALESCE(parent.metadata, '{}'::jsonb),
    '{archived_reason}',
    to_jsonb('auto-archived after >7d in reverted state with no active descendants (2026-04-25)'::text)
  )
WHERE parent.status = 'reverted'
  AND parent.updated_at < NOW() - INTERVAL '7 days'
  AND NOT EXISTS (
    SELECT 1 FROM public.dev_autopilot_executions child
    WHERE child.parent_execution_id = parent.id
      AND child.status NOT IN ('completed', 'failed', 'failed_escalated', 'cancelled', 'auto_archived', 'self_healed')
  );
