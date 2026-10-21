-- =============================================================================
-- VTID-02779 — Voice clock: alarms, countdown timers, pomodoro blocks
--
-- Backing table for the ORB voice tools set_alarm / list_alarms / delete_alarm /
-- start_timer / start_pomodoro / list_active_timers
-- (services/gateway/src/services/orb-tools/reminders-clock-tools.ts).
--
-- One row per clock item. `fires_at` is the absolute UTC instant the item
-- should ring; `recurrence` ('daily'|'weekdays', NULL = one-shot) applies to
-- alarms only; `duration_seconds` applies to timers/pomodoros only.
--
-- NOTE: FIRING is a follow-up — a cron/tick job (like /reminders-tick for the
-- reminders table) must claim rows whose fires_at has passed, deliver a push /
-- chime, and transition status active→fired. This migration + the voice tools
-- ship the data layer and read/write paths only.
-- =============================================================================

CREATE TABLE IF NOT EXISTS voice_clock_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid,
  user_id          uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('alarm','timer','pomodoro')),
  label            text,
  fires_at         timestamptz,
  recurrence       text,           -- 'daily' | 'weekdays' | NULL = one-shot (alarms only)
  duration_seconds int,            -- timers/pomodoros only
  status           text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','fired','cancelled','completed')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Voice tool list/delete queries: WHERE user_id = X AND status = 'active'
CREATE INDEX IF NOT EXISTS idx_voice_clock_items_user_status
  ON voice_clock_items (user_id, status);

-- Future tick job: fast lookup of active rows past their fire time
CREATE INDEX IF NOT EXISTS idx_voice_clock_items_tick
  ON voice_clock_items (fires_at)
  WHERE status = 'active';

ALTER TABLE voice_clock_items ENABLE ROW LEVEL SECURITY;

-- Users manage their own clock items (direct client access, e.g. UI list).
CREATE POLICY "Users manage own voice clock items"
  ON voice_clock_items FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Gateway service-role access (voice tools run with the service-role client;
-- their WHERE user_id clauses are the tenant isolation). Restricted TO
-- service_role — without this clause the policy applies to EVERY role
-- (including `authenticated`), letting any logged-in user read/write any
-- other user's alarms/timers since USING(true)/WITH CHECK(true) has no
-- owner constraint. The service-role client already bypasses RLS entirely,
-- so this policy is defense-in-depth, not the enforcement mechanism.
CREATE POLICY "Service role full access on voice_clock_items"
  ON voice_clock_items FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON voice_clock_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON voice_clock_items TO service_role;

COMMENT ON TABLE voice_clock_items IS
  'VTID-02779 voice-created alarms/timers/pomodoros. Written by ORB voice tools (set_alarm, start_timer, start_pomodoro). Firing/delivery is a cron follow-up.';
