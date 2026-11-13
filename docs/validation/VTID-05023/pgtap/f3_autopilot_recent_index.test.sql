-- VTID-05023 F3: after 20260116000001 the broken recent index is gone, the processed_at index survives,
-- and a second apply is a no-op. Run: pglite-harness/run.mjs --sql f3_stub.sql --sql <migration> --sql <migration> this file.
SELECT extensions.plan(3);
SELECT extensions.ok(
  NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_autopilot_processed_events_recent'),
  'recent index is dropped by the fix migration');
SELECT extensions.ok(
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_autopilot_processed_events_processed_at'),
  'processed_at index used by the time-window queries still exists');
SELECT extensions.ok(
  NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'autopilot_processed_events' AND indexdef ILIKE '%WHERE%'),
  'no partial index with a time predicate remains on autopilot_processed_events');
