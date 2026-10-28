-- VTID-0526-D: Add task_stage column for 4-stage telemetry standardization
-- Purpose: Enable tracking of PLANNER, WORKER, VALIDATOR, DEPLOY stages
-- Idempotent: Safe to run multiple times
--
-- NOTE: The oasis_events table is used by telemetry endpoints (/api/v1/telemetry/*).
-- This migration creates the table if it doesn't exist, then adds the task_stage column.

-- Step 1: Create oasis_events table if it doesn't exist
-- This table stores telemetry events from gateway services
CREATE TABLE IF NOT EXISTS public.oasis_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Core event identification
  vtid          text,
  kind          text,
  status        text,
  title         text,
  -- Source information
  source        text,
  layer         text,
  module        text,
  -- References and links
  ref           text,
  link          text,
  -- Legacy fields (used by events.ts)
  topic         text,
  service       text,
  role          text,
  model         text,
  message       text,
  -- Metadata
  meta          jsonb DEFAULT '{}'::jsonb,
  metadata      jsonb DEFAULT '{}'::jsonb,
  -- VTID-0526-D: Task stage for telemetry standardization
  task_stage    text
);

-- Step 2: Add task_stage column if table existed but column doesn't
-- (for existing Supabase instances where table was created manually)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'oasis_events'
      AND column_name = 'task_stage'
  ) THEN
    ALTER TABLE public.oasis_events ADD COLUMN task_stage text;
    RAISE NOTICE 'Added task_stage column to oasis_events';
  ELSE
    RAISE NOTICE 'task_stage column already exists';
  END IF;
END$$;

-- Step 3: Add check constraint for valid stage values (if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oasis_events_task_stage_check'
  ) THEN
    -- Valid stages: PLANNER, WORKER, VALIDATOR, DEPLOY (or NULL for events without stage)
    ALTER TABLE public.oasis_events
    ADD CONSTRAINT oasis_events_task_stage_check
    CHECK (task_stage IS NULL OR task_stage IN ('PLANNER', 'WORKER', 'VALIDATOR', 'DEPLOY'));
    RAISE NOTICE 'Added task_stage check constraint';
  END IF;
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'Constraint already exists, skipping';
END$$;

-- Step 4: Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_oasis_events_task_stage
  ON public.oasis_events (task_stage);

CREATE INDEX IF NOT EXISTS idx_oasis_events_stage_created
  ON public.oasis_events (task_stage, created_at DESC)
  WHERE task_stage IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_oasis_events_created_at
  ON public.oasis_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_oasis_events_vtid
  ON public.oasis_events (vtid);

-- Step 5: Add comment for documentation
COMMENT ON COLUMN public.oasis_events.task_stage IS 'Execution stage: PLANNER, WORKER, VALIDATOR, or DEPLOY (VTID-0526-D)';

-- Step 6: Create RPC function for counting events by stage (used by telemetry snapshot)
CREATE OR REPLACE FUNCTION public.count_events_by_stage(since_time TIMESTAMPTZ DEFAULT NOW() - INTERVAL '24 hours')
RETURNS TABLE(task_stage TEXT, count BIGINT) AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.task_stage,
    COUNT(*)::BIGINT as count
  FROM public.oasis_events e
  WHERE e.task_stage IS NOT NULL
    AND e.created_at >= since_time
  GROUP BY e.task_stage;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Step 7: Grant permissions
GRANT SELECT, INSERT, UPDATE ON public.oasis_events TO service_role;
GRANT SELECT ON public.oasis_events TO authenticated;
GRANT EXECUTE ON FUNCTION public.count_events_by_stage(TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.count_events_by_stage(TIMESTAMPTZ) TO authenticated;

-- Step 8: Log migration success to oasis_events_v1 (governance events) if it exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'oasis_events_v1') THEN
    INSERT INTO public.oasis_events_v1 (tenant, task_type, assignee_ai, rid, status, notes, metadata)
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
    RAISE NOTICE 'Logged migration to oasis_events_v1';
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not log to oasis_events_v1: %', SQLERRM;
END$$;

-- Verification query (run manually to verify):
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'oasis_events'
-- ORDER BY ordinal_position;
