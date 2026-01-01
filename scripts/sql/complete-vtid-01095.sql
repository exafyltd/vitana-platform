-- VTID-01095: Daily Scheduler Wiring - Emit lifecycle completion event
-- Run this against the Supabase database to move task to COMPLETED
--
-- Implementation summary:
-- - Created daily_recompute_runs table for idempotency tracking
-- - Implemented stub RPC functions (longevity, topics, community_recs, matches)
-- - Created DailyRecomputeService with fixed-order pipeline
-- - Added scheduler routes: POST /api/v1/scheduler/daily-recompute, GET /status
-- - Wired OASIS events for all stages with terminal completion

INSERT INTO oasis_events (
  id,
  created_at,
  vtid,
  topic,
  service,
  role,
  model,
  status,
  message,
  link,
  metadata
) VALUES (
  gen_random_uuid(),
  NOW(),
  'VTID-01095',
  'vtid.lifecycle.completed',
  'vtid-lifecycle-claude',
  'INFRA',
  'daily-scheduler-wiring',
  'success',
  'Daily Scheduler Wiring implemented: idempotent pipeline with OASIS terminal events for longevity/topics/community_recs/matches stages',
  'https://github.com/exafyltd/vitana-platform/pull/new/claude/wire-daily-scheduler-85nf1',
  jsonb_build_object(
    'vtid', 'VTID-01095',
    'outcome', 'success',
    'source', 'claude',
    'terminal', true,
    'completed_at', NOW()::text,
    'deliverables', jsonb_build_array(
      'supabase/migrations/20251231000001_vtid_01095_daily_scheduler.sql',
      'services/gateway/src/services/daily-recompute-service.ts',
      'services/gateway/src/routes/scheduler.ts'
    ),
    'endpoints', jsonb_build_array(
      'POST /api/v1/scheduler/daily-recompute',
      'GET /api/v1/scheduler/daily-recompute/status'
    ),
    'pipeline_stages', jsonb_build_array(
      'longevity',
      'topics',
      'community_recs',
      'matches'
    ),
    'oasis_events', jsonb_build_array(
      'vtid.daily_recompute.started',
      'vtid.stage.longevity.success',
      'vtid.stage.longevity.failed',
      'vtid.stage.topics.success',
      'vtid.stage.topics.failed',
      'vtid.stage.community_recs.success',
      'vtid.stage.community_recs.failed',
      'vtid.stage.matches.success',
      'vtid.stage.matches.failed',
      'vtid.daily_recompute.completed',
      'vtid.daily_recompute.failed'
    )
  )
);

-- Also update vtid_ledger status to 'complete' for consistency
UPDATE vtid_ledger
SET status = 'complete',
    updated_at = NOW()
WHERE vtid = 'VTID-01095';
