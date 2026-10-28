-- VTID-01841: Task Failure Retry Lifecycle
-- When a task fails, it returns to 'scheduled' with a failure flag instead of becoming permanently terminal.
-- Only after MAX_FAILURE_COUNT (3) consecutive failures does a task become permanently terminal.

-- Add retry tracking columns to vtid_ledger
ALTER TABLE vtid_ledger ADD COLUMN IF NOT EXISTS failure_count INTEGER DEFAULT 0;
ALTER TABLE vtid_ledger ADD COLUMN IF NOT EXISTS last_failure_at TIMESTAMPTZ;

-- Reset the 4 existing failed tasks back to scheduled for retry
UPDATE vtid_ledger
SET status = 'scheduled',
    is_terminal = false,
    terminal_outcome = NULL,
    failure_count = 1,
    last_failure_at = COALESCE(completed_at, NOW()),
    completed_at = NULL,
    updated_at = NOW()
WHERE vtid IN ('VTID-01217', 'VTID-01841', 'VTID-01844', 'VTID-01843')
  AND is_terminal = true;

-- Emit retry_reset OASIS events for the reset tasks
INSERT INTO oasis_events (vtid, topic, service, role, status, message, metadata)
SELECT
  vtid,
  'vtid.lifecycle.retry_reset',
  'migration',
  'SYSTEM',
  'info',
  'Task reset for retry via migration (VTID-01841)',
  jsonb_build_object(
    'action', 'migration_reset',
    'failure_count', 1,
    'reason', 'initial_retry_lifecycle_migration'
  )
FROM vtid_ledger
WHERE vtid IN ('VTID-01217', 'VTID-01841', 'VTID-01844', 'VTID-01843');
