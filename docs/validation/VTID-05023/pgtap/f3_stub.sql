-- VTID-05023 F3 stub: the table and the two indexes the original 20260116000000 migration leaves usable.
-- The broken partial index is stood in by a plain index of the same name, so the migration under test has something to drop.
CREATE TABLE IF NOT EXISTS public.autopilot_processed_events (
    event_id text PRIMARY KEY,
    vtid text,
    event_type text,
    processed_at timestamptz,
    event_timestamp timestamptz
);
CREATE INDEX IF NOT EXISTS idx_autopilot_processed_events_processed_at ON public.autopilot_processed_events (processed_at);
CREATE INDEX IF NOT EXISTS idx_autopilot_processed_events_recent ON public.autopilot_processed_events (processed_at);
