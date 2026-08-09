-- DEV-COMHU-0503 — ORB Recovery 2+3: shared cross-transport session state.
--
-- Backs close/reopen continuity, the audio-ready ack (ORB-4), and the pending
-- autopilot CTA (ORB-5). Short-lived, TTL'd rows keyed by (user_id, key).
--
-- NOTE: written as a migration FILE by the autonomous run; apply via the normal
-- Supabase migration flow. Not executed from the sandbox.
--
-- APPLIED 2026-08-03 under VTID-03480 — and NOT before. This file sat
-- unapplied in production for ~2 months. Because every caller in
-- services/gateway/src/services/orb/orb-session-state.ts fails soft (reads
-- return null, writes return ok:false and never throw), nothing broke loudly:
-- the ORB audio-ready handshake, close/reopen continuity, the pending
-- autopilot CTA and wake-brief opener rotation were all silently inert.
-- The only visible trace was `orb.session.audio_ready.acked` carrying
-- ok:false on every single session. Verified after applying: that same
-- event flipped to ok:true on the next live session, with no redeploy —
-- the code had always been calling this table correctly.

CREATE TABLE IF NOT EXISTS orb_session_state (
  user_id      UUID NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  key          TEXT NOT NULL,           -- 'continuity', 'pending_cta', 'audio_ready_ack', ...
  value        JSONB NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS orb_session_state_expires_at_idx
  ON orb_session_state (expires_at);

-- TTL cleanup helper — invoked from the daily GC cron.
CREATE OR REPLACE FUNCTION orb_session_state_gc()
RETURNS void LANGUAGE sql AS $$
  DELETE FROM orb_session_state WHERE expires_at < NOW();
$$;

-- RLS: writes go through the gateway (service role); enable RLS and allow the
-- owning user to read their own rows. Service role bypasses RLS for writes.
ALTER TABLE orb_session_state ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'orb_session_state'
      AND policyname = 'orb_session_state_owner_read'
  ) THEN
    CREATE POLICY orb_session_state_owner_read
      ON orb_session_state FOR SELECT
      USING (user_id = auth.uid());
  END IF;
END$$;
