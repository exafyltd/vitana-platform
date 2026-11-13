-- VTID-05023 F3: fix the index predicate that PostgreSQL rejects.
--
-- The original migration 20260116000000_vtid_01179_autopilot_event_loop.sql created
-- idx_autopilot_processed_events_recent with WHERE processed_at > NOW() - INTERVAL '1 hour'.
-- NOW() is not IMMUTABLE, so PostgreSQL fails with "functions in index predicate must be marked IMMUTABLE".
--
-- The intent is a one-hour time window. A time window cannot be an index predicate, so it is a query
-- condition instead. The stats functions in the original migration already filter on
-- processed_at > NOW() - INTERVAL '1 hour', and idx_autopilot_processed_events_processed_at
-- (created by the original migration) serves that range. No replacement index is created here.
--
-- Idempotent: DROP INDEX IF EXISTS is a no-op when the index is absent.

DROP INDEX IF EXISTS public.idx_autopilot_processed_events_recent;
