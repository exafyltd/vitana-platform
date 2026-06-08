-- VTID-03159 — Defensive ADD COLUMN IF NOT EXISTS for user_journey.
--
-- During VTID-03157 runtime test the founder ran an UPDATE against
-- user_journey.last_session_date and Postgres returned
-- "column last_session_date does not exist". This implies the
-- VTID-03152 migration (20260603000000_VTID_03152_user_journey_table.sql)
-- ran with CREATE TABLE IF NOT EXISTS against an already-existing
-- public.user_journey, making the column-list a no-op. The two known
-- ways that could have happened:
--   (a) Another VTID-03152-tagged change (PR #2326) shipped on the
--       same day; if its branch carried a partial user_journey table
--       definition that ran first against the same DB, our CREATE
--       was skipped.
--   (b) A pre-merge dispatch of RUN-MIGRATION.yml against a stale
--       branch checkout created a partial table.
--
-- Either way, the remediation is the same: defensively ADD COLUMN IF
-- NOT EXISTS for every field VTID-03152 declared. ALTER TABLE … ADD
-- COLUMN IF NOT EXISTS is idempotent — safe to run regardless of
-- whether the column already exists.
--
-- This migration is structural-only. No data writes, no destructive
-- changes. After applying it, the foundation layer (Slice A) is
-- guaranteed to have the full column set whether or not the original
-- migration's column list landed.

BEGIN;

ALTER TABLE public.user_journey
  ADD COLUMN IF NOT EXISTS tenant_id                UUID,
  ADD COLUMN IF NOT EXISTS started_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS total_days               INT NOT NULL DEFAULT 90,
  ADD COLUMN IF NOT EXISTS plan_type                TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS plan_summary             TEXT,
  ADD COLUMN IF NOT EXISTS current_wave_id          TEXT,
  ADD COLUMN IF NOT EXISTS current_milestone_id     TEXT,
  ADD COLUMN IF NOT EXISTS status                   TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS completed_milestone_ids  TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_first_session         BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_session_date        DATE,
  ADD COLUMN IF NOT EXISTS last_acknowledged_day    INT,
  ADD COLUMN IF NOT EXISTS recent_greeting_openings TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS plan_negotiated_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at               TIMESTAMPTZ NOT NULL DEFAULT now();

-- Add the CHECK constraints idempotently (DO NOTHING if they already
-- exist).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_journey_plan_type_check'
      AND conrelid = 'public.user_journey'::regclass
  ) THEN
    ALTER TABLE public.user_journey
      ADD CONSTRAINT user_journey_plan_type_check
      CHECK (plan_type IN ('default','personalized'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_journey_status_check'
      AND conrelid = 'public.user_journey'::regclass
  ) THEN
    ALTER TABLE public.user_journey
      ADD CONSTRAINT user_journey_status_check
      CHECK (status IN ('active','paused','complete','restarted'));
  END IF;
END $$;

-- Indexes (idempotent).
CREATE INDEX IF NOT EXISTS user_journey_status_active_idx
  ON public.user_journey(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS user_journey_tenant_idx
  ON public.user_journey(tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS user_journey_last_session_idx
  ON public.user_journey(last_session_date) WHERE last_session_date IS NOT NULL;

-- Ensure the updated_at trigger exists.
CREATE OR REPLACE FUNCTION public.user_journey_touch_updated_at()
  RETURNS TRIGGER AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_journey_updated_at_trigger ON public.user_journey;
CREATE TRIGGER user_journey_updated_at_trigger
  BEFORE UPDATE ON public.user_journey
  FOR EACH ROW
  EXECUTE FUNCTION public.user_journey_touch_updated_at();

-- Tell PostgREST to reload its schema cache so the new columns are
-- immediately readable through PostgREST (Supabase REST API).
NOTIFY pgrst, 'reload schema';

COMMIT;
