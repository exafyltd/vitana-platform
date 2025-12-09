-- VTID-0526-D: Add task_stage column for 4-stage telemetry standardization
-- Purpose: Enable tracking of PLANNER, WORKER, VALIDATOR, DEPLOY stages
-- Idempotent: Safe to run multiple times

-- Add task_stage column to oasis_events if not exists
ALTER TABLE oasis_events
  ADD COLUMN IF NOT EXISTS task_stage TEXT;

-- Add check constraint for valid stage values (if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oasis_events_task_stage_check'
  ) THEN
    -- Note: We use TEXT with a CHECK rather than ENUM for flexibility
    -- Valid stages: PLANNER, WORKER, VALIDATOR, DEPLOY (or NULL for events without stage)
    ALTER TABLE oasis_events
    ADD CONSTRAINT oasis_events_task_stage_check
    CHECK (task_stage IS NULL OR task_stage IN ('PLANNER', 'WORKER', 'VALIDATOR', 'DEPLOY'));
  END IF;
END$$;

-- Create index for stage-based queries
CREATE INDEX IF NOT EXISTS idx_oasis_events_task_stage
  ON oasis_events (task_stage);

-- Composite index for stage + created_at (for counters/aggregations)
CREATE INDEX IF NOT EXISTS idx_oasis_events_stage_created
  ON oasis_events (task_stage, created_at DESC)
  WHERE task_stage IS NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN oasis_events.task_stage IS 'Execution stage: PLANNER, WORKER, VALIDATOR, or DEPLOY (VTID-0526-D)';

-- Log migration event (if oasis_events_v1 exists for governance)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'oasis_events_v1') THEN
    INSERT INTO oasis_events_v1 (tenant, task_type, assignee_ai, rid, status, notes, metadata)
    VALUES (
      '__SYSTEM__',
      'migration',
      'claude',
      'VTID-0526-D-migration',
      'success',
      'Added task_stage column for 4-stage telemetry standardization',
      jsonb_build_object(
        'vtid', 'VTID-0526-D',
        'column', 'task_stage',
        'valid_values', jsonb_build_array('PLANNER', 'WORKER', 'VALIDATOR', 'DEPLOY')
      )
    );
  END IF;
END$$;

-- Create RPC function for counting events by stage (used by telemetry snapshot)
CREATE OR REPLACE FUNCTION count_events_by_stage(since_time TIMESTAMPTZ DEFAULT NOW() - INTERVAL '24 hours')
RETURNS TABLE(task_stage TEXT, count BIGINT) AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.task_stage,
    COUNT(*)::BIGINT as count
  FROM oasis_events e
  WHERE e.task_stage IS NOT NULL
    AND e.created_at >= since_time
  GROUP BY e.task_stage;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Grant execute on the function
GRANT EXECUTE ON FUNCTION count_events_by_stage(TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION count_events_by_stage(TIMESTAMPTZ) TO authenticated;

-- Verification query (informational)
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'oasis_events' AND column_name = 'task_stage';
