-- =============================================================================
-- VTID-02601 — Reminder feature: voice-creatable reminders with audio interrupt
--
-- A reminder is a user-defined moment in time at which Vitana should chime + speak.
-- Created via the ORB voice tool `set_reminder` (or REST /api/v1/reminders).
-- Fired by the Cloud Scheduler tick endpoint /reminders-tick every 30s.
-- Delivered via SSE (PR-2) to the active client overlay; FCM fallback (PR-4).
--
-- Soft-delete only (status='cancelled'). Recurrence column reserved for V2.
-- =============================================================================

CREATE TABLE IF NOT EXISTS reminders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL,
  tenant_id           uuid NOT NULL,
  -- content
  action_text         text NOT NULL,
  spoken_message      text NOT NULL,
  description         text,
  -- scheduling
  next_fire_at        timestamptz NOT NULL,
  user_tz             text NOT NULL DEFAULT 'UTC',
  recurrence_rule     text, -- RRULE for V2; NULL = single-shot
  -- delivery state machine: pending|dispatching|fired|completed|failed|cancelled
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','dispatching','fired','completed','failed','cancelled')),
  dispatch_started_at timestamptz,
  fired_at            timestamptz,
  acked_at            timestamptz,
  delivery_via        text, -- sse|fcm|manual_replay|none
  dispatch_attempts   int NOT NULL DEFAULT 0,
  snooze_count        int NOT NULL DEFAULT 0,
  -- audio (pre-rendered TTS)
  tts_audio_b64       text,        -- base64 MP3, NULL means render at fire time
  tts_voice           text,
  tts_lang            text,
  -- linkage
  calendar_event_id   uuid,
  -- audit
  created_via         text NOT NULL CHECK (created_via IN ('voice','ui','system')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Tick query: fast lookup of pending+dispatching rows past their fire time
CREATE INDEX IF NOT EXISTS reminders_tick_idx
  ON reminders (next_fire_at)
  WHERE status IN ('pending','dispatching');

-- User list query: upcoming + recently fired
CREATE INDEX IF NOT EXISTS reminders_user_active_idx
  ON reminders (user_id, next_fire_at)
  WHERE status IN ('pending','dispatching','fired');

-- Recent history per user
CREATE INDEX IF NOT EXISTS reminders_user_recent_idx
  ON reminders (user_id, created_at DESC);

-- Row-level security: only the owner can SELECT/UPDATE/DELETE.
-- Service-role calls (gateway with SERVICE_ROLE key) bypass RLS as usual.
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reminders_owner_select ON reminders;
CREATE POLICY reminders_owner_select ON reminders
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS reminders_owner_insert ON reminders;
CREATE POLICY reminders_owner_insert ON reminders
  FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS reminders_owner_update ON reminders;
CREATE POLICY reminders_owner_update ON reminders
  FOR UPDATE USING (user_id = auth.uid());

DROP POLICY IF EXISTS reminders_owner_delete ON reminders;
CREATE POLICY reminders_owner_delete ON reminders
  FOR DELETE USING (user_id = auth.uid());

-- updated_at autotouch trigger
CREATE OR REPLACE FUNCTION reminders_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reminders_touch_updated_at_t ON reminders;
CREATE TRIGGER reminders_touch_updated_at_t
  BEFORE UPDATE ON reminders
  FOR EACH ROW EXECUTE FUNCTION reminders_touch_updated_at();

-- LISTEN/NOTIFY trigger so any gateway pod can fan out to its SSE subscribers
-- when a reminder transitions to 'fired' state.
CREATE OR REPLACE FUNCTION reminders_notify_fire()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'fired' AND (OLD.status IS DISTINCT FROM 'fired') THEN
    PERFORM pg_notify(
      'reminder_fired',
      json_build_object(
        'reminder_id', NEW.id,
        'user_id',     NEW.user_id,
        'tenant_id',   NEW.tenant_id
      )::text
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reminders_notify_fire_t ON reminders;
CREATE TRIGGER reminders_notify_fire_t
  AFTER UPDATE ON reminders
  FOR EACH ROW EXECUTE FUNCTION reminders_notify_fire();

GRANT SELECT, INSERT, UPDATE, DELETE ON reminders TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON reminders TO service_role;

COMMENT ON TABLE reminders IS
  'VTID-02601 user-defined reminders fired by /reminders-tick. Voice-creatable via set_reminder tool. Soft-delete via status=cancelled.';

-- ============================================================================
-- reminders_claim_due — atomic claim of due rows for the tick endpoint.
-- Uses FOR UPDATE SKIP LOCKED so multiple gateway pods can run the tick
-- concurrently without double-firing. Rows transition pending→dispatching
-- inside a single transaction.
-- ============================================================================
CREATE OR REPLACE FUNCTION reminders_claim_due(
  p_lookahead_seconds int DEFAULT 15,
  p_limit int DEFAULT 200
)
RETURNS SETOF reminders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT id FROM reminders
     WHERE status = 'pending'
       AND next_fire_at <= now() + (p_lookahead_seconds || ' seconds')::interval
     ORDER BY next_fire_at
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE reminders r
     SET status = 'dispatching',
         dispatch_started_at = now()
   WHERE r.id IN (SELECT id FROM due)
  RETURNING r.*;
END;
$$;

GRANT EXECUTE ON FUNCTION reminders_claim_due(int, int) TO service_role;
COMMENT ON FUNCTION reminders_claim_due IS
  'VTID-02601 atomic claim of due reminders for the /reminders-tick endpoint. Multi-pod-safe via FOR UPDATE SKIP LOCKED.';
