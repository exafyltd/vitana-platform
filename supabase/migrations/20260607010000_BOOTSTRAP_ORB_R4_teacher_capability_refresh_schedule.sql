-- BOOTSTRAP-ORB-R4-GRADUATED-TEACHER — graduated-user Teacher track schedule.
--
-- Phase R4 of the ORB R0–R9 reconciliation
-- (docs/superpowers/plans/2026-05-30-vitana-assistant-original-plan-reconciliation.md).
--
-- PROBLEM (Dragan1 case): once a user has worked through the linear
-- curriculum — every enabled capability is introduced / tried / completed /
-- mastered within its cooldown window — `pickCapability` returns null and the
-- Teacher SUPPRESSES, falling through to the bare voice-wake-brief. The
-- graduated user gets nothing new from the Teacher ever again.
--
-- R4 makes the Teacher RE-ENGAGE instead of suppressing:
--   1. DEEPENING REFRESH — re-introduce a `tried` capability with next-level
--      framing IF its refresh schedule is due. Gated by this table:
--      per (user_id × capability_key) "next refresh ok at", 90-day default.
--   2. GRACEFUL PAUSE — if nothing is refresh-eligible, speak ONE gentle line
--      ("You've explored most of what Vitana offers…") then stay silent on
--      subsequent same-day opens. The same-day silence is enforced by stamping
--      a `__graceful_pause__` sentinel row in this table (next_refresh_ok_at =
--      start of next local day) — no separate table needed.
--
-- This is a migration FILE only. It is NOT executed from the sandbox. Apply via
-- the normal Supabase migration flow.

-- ---------------------------------------------------------------
-- teacher_capability_refresh_schedule — per (user, capability) refresh gate
-- ---------------------------------------------------------------
-- A row's presence means "this capability has been refreshed (or pause-stamped)
-- for this user; do not refresh again until next_refresh_ok_at". Absence means
-- "never refreshed → eligible the moment the capability becomes `tried`".
--
-- The graceful-pause sentinel uses the reserved capability_key
-- '__graceful_pause__' (no real capability has a key starting with '__'), so it
-- shares the same table + (user_id, capability_key) primary key without a
-- second relation.

CREATE TABLE IF NOT EXISTS teacher_capability_refresh_schedule (
  tenant_id            UUID NOT NULL,
  user_id              UUID NOT NULL,
  -- Real capability_key (soft-linked to system_capabilities) OR the reserved
  -- '__graceful_pause__' sentinel. We do NOT add a hard FK so the sentinel row
  -- and capabilities removed from the catalog don't cascade-delete the gate.
  capability_key       TEXT NOT NULL,
  -- The Teacher may re-introduce this capability with deepening framing on or
  -- after this instant. 90-day default cadence from the last refresh.
  next_refresh_ok_at   TIMESTAMPTZ NOT NULL,
  -- How many times this capability has been deepening-refreshed for this user.
  -- Drives escalating framing ("revisit" -> "go deeper") and lets operators see
  -- who has fully graduated.
  refresh_count        INT NOT NULL DEFAULT 0,
  -- Last time a refresh actually fired (NULL for a pure pause-sentinel row).
  last_refreshed_at    TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, capability_key)
);

-- The provider reads "all schedule rows for this user" on every graduated-track
-- evaluation, exactly like it reads the awareness ledger.
CREATE INDEX IF NOT EXISTS teacher_capability_refresh_schedule_user_idx
  ON teacher_capability_refresh_schedule (tenant_id, user_id);

-- Operators: who is due for a refresh right now.
CREATE INDEX IF NOT EXISTS teacher_capability_refresh_schedule_due_idx
  ON teacher_capability_refresh_schedule (next_refresh_ok_at);

CREATE OR REPLACE FUNCTION teacher_capability_refresh_schedule_touch_updated_at()
  RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS teacher_capability_refresh_schedule_updated_at_trigger
  ON teacher_capability_refresh_schedule;
CREATE TRIGGER teacher_capability_refresh_schedule_updated_at_trigger
  BEFORE UPDATE ON teacher_capability_refresh_schedule
  FOR EACH ROW
  EXECUTE FUNCTION teacher_capability_refresh_schedule_touch_updated_at();

-- RLS: owning user reads their own rows; service role (gateway) bypasses RLS
-- for the writes. Matches orb_session_state / user_capability_awareness.
ALTER TABLE teacher_capability_refresh_schedule ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'teacher_capability_refresh_schedule'
      AND policyname = 'teacher_capability_refresh_schedule_owner_read'
  ) THEN
    CREATE POLICY teacher_capability_refresh_schedule_owner_read
      ON teacher_capability_refresh_schedule
      FOR SELECT
      TO authenticated
      USING (user_id = auth.uid());
  END IF;
END$$;

-- ---------------------------------------------------------------
-- record_teacher_refresh() — idempotent upsert the provider calls after a
-- refresh OR a graceful-pause stamp fires. Single round-trip, advances the
-- 90-day (default) cadence, increments refresh_count for real refreshes.
-- ---------------------------------------------------------------
-- p_capability_key:  real capability_key OR '__graceful_pause__'
-- p_next_ok_at:      when the next refresh / pause-reset is allowed. For a
--                    deepening refresh the caller passes now + 90d; for a
--                    graceful-pause sentinel it passes the start of the user's
--                    next local day (so the pause line repeats at most once/day).
-- p_is_refresh:      true for a real deepening refresh (bumps refresh_count +
--                    last_refreshed_at); false for a pure pause-sentinel stamp.

CREATE OR REPLACE FUNCTION record_teacher_refresh(
  p_tenant_id      UUID,
  p_user_id        UUID,
  p_capability_key TEXT,
  p_next_ok_at     TIMESTAMPTZ,
  p_is_refresh     BOOLEAN DEFAULT true
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO teacher_capability_refresh_schedule AS s (
    tenant_id, user_id, capability_key,
    next_refresh_ok_at, refresh_count, last_refreshed_at
  ) VALUES (
    p_tenant_id, p_user_id, p_capability_key,
    p_next_ok_at,
    CASE WHEN p_is_refresh THEN 1 ELSE 0 END,
    CASE WHEN p_is_refresh THEN now() ELSE NULL END
  )
  ON CONFLICT (tenant_id, user_id, capability_key) DO UPDATE
  SET next_refresh_ok_at = EXCLUDED.next_refresh_ok_at,
      refresh_count = s.refresh_count + (CASE WHEN p_is_refresh THEN 1 ELSE 0 END),
      last_refreshed_at = CASE WHEN p_is_refresh THEN now() ELSE s.last_refreshed_at END,
      updated_at = now();
END;
$$;

-- Lock down the SECURITY DEFINER write RPC. By default Postgres grants EXECUTE
-- to PUBLIC, which would let any authenticated/anon client call
-- /rpc/record_teacher_refresh with an arbitrary p_tenant_id/p_user_id and upsert
-- ANOTHER user's schedule rows (push deepening refreshes / pause sentinel into the
-- future), bypassing the table's owner-read-only RLS. Service-role only — the
-- gateway must use the admin Supabase client. Matches
-- scheduler_vitana_index_compute_daily / health_compute_vitana_index_for_user.
REVOKE ALL ON FUNCTION record_teacher_refresh(UUID, UUID, TEXT, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_teacher_refresh(UUID, UUID, TEXT, TIMESTAMPTZ, BOOLEAN) FROM authenticated;
REVOKE ALL ON FUNCTION record_teacher_refresh(UUID, UUID, TEXT, TIMESTAMPTZ, BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION record_teacher_refresh(UUID, UUID, TEXT, TIMESTAMPTZ, BOOLEAN) TO service_role;

COMMENT ON TABLE teacher_capability_refresh_schedule IS
  'BOOTSTRAP-ORB-R4: per (user, capability) deepening-refresh gate for the graduated-user Teacher track. capability_key=__graceful_pause__ is the reserved same-day pause sentinel. 90-day default cadence.';
COMMENT ON FUNCTION record_teacher_refresh IS
  'BOOTSTRAP-ORB-R4: idempotent upsert advancing the refresh/pause cadence. p_is_refresh=false stamps a pause sentinel without bumping refresh_count.';
