-- VTID-05162 (Health Hub Phase 1 / B2, program VTID-05020) — the derived
-- shadow of health_features_daily and its two helper tables (plan
-- docs/validation/VTID-05162/plan-sparring.md, B Change 9):
--   * health_features_daily_v2            what package B derives from the health
--                                         store (Change 8). Same columns and unique
--                                         key as health_features_daily, plus
--                                         derivation_version and source_kinds.
--                                         Nothing a member sees reads it; B3
--                                         compares it with the live Index inputs.
--   * health_features_daily_legacy_shadow same columns as health_features_daily.
--                                         Created EMPTY now; used only after B3's
--                                         cutover (legacy-shaped rows kept for
--                                         rollback).
--   * health_features_derivation_pending  one marker per member-day whose store
--                                         data changed and is not derived yet
--                                         (written before the writer's response,
--                                         deleted by a successful derivation,
--                                         caught up nightly after 5 minutes).
--
-- APPLY TARGET: Aurora only (0T; production after the cutover). Never Supabase.
-- Same placement guard as the VTID-05158 store and VTID-05161 health_sources
-- migrations: it refuses a database that has both auth.users and
-- storage.objects (Supabase) unless the session sets
-- vitana.health_store_target = 'aurora'. MIGRATION-DRIFT-CHECK lists the three
-- tables as Aurora-only (scripts/ci/migration-drift-baseline.json
-- `aurora_only_tables`) and FAILS if one ever appears on Supabase.
--
-- Design:
--   * schema public, tenant_id + user_id NOT NULL, NO foreign key to
--     auth.users and no erasure_registry entry: erase_user_data() finds all
--     three by its catalogue scan (no change to that function).
--   * service-role only: RLS on, no policy, every privilege revoked from
--     PUBLIC / anon / authenticated. The gateway is the only writer and reader.
--   * health_features_daily's columns are the union of its two creating
--     migrations (VTID-01078: provenance; VTID-01103 + the 2026-04-23 repair:
--     feature_unit, sample_count, confidence, metadata, updated_at).

BEGIN;

-- 1. Placement guard (VTID-05158 pattern).
DO $guard$
BEGIN
  IF coalesce(current_setting('vitana.health_store_target', true), '') <> 'aurora'
     AND to_regclass('auth.users') IS NOT NULL
     AND to_regclass('storage.objects') IS NOT NULL THEN
    RAISE EXCEPTION 'VTID-05162 health store placement guard: this database has auth.users and storage.objects (Supabase). health_features_daily_v2, health_features_daily_legacy_shadow and health_features_derivation_pending are Aurora-only. On Aurora with an auth shim, SET vitana.health_store_target = ''aurora'' first.'
      USING ERRCODE = 'P0001';
  END IF;
END
$guard$;

SET LOCAL lock_timeout = '5s';

-- 2. health_features_daily_v2.
CREATE TABLE IF NOT EXISTS public.health_features_daily_v2 (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  user_id             uuid NOT NULL,
  date                date NOT NULL,
  feature_key         text NOT NULL,
  feature_value       numeric NOT NULL,
  feature_unit        text,
  sample_count        integer DEFAULT 0,
  confidence          numeric DEFAULT 1.0,
  metadata            jsonb DEFAULT '{}'::jsonb,
  provenance          jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  derivation_version  text NOT NULL,
  source_kinds        text[] NOT NULL DEFAULT '{}'::text[],
  CONSTRAINT health_features_daily_v2_unique UNIQUE (tenant_id, user_id, date, feature_key),
  CONSTRAINT health_features_daily_v2_source_kinds_check CHECK (
    source_kinds <@ ARRAY['device_cloud', 'aggregator', 'phone_store', 'partner', 'manual', 'voice', 'diary', 'unknown']::text[])
);
CREATE INDEX IF NOT EXISTS health_features_daily_v2_tenant_user_date_idx
  ON public.health_features_daily_v2 (tenant_id, user_id, date);

-- 3. health_features_daily_legacy_shadow (empty until B3's cutover).
CREATE TABLE IF NOT EXISTS public.health_features_daily_legacy_shadow (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  user_id        uuid NOT NULL,
  date           date NOT NULL,
  feature_key    text NOT NULL,
  feature_value  numeric NOT NULL,
  feature_unit   text,
  sample_count   integer DEFAULT 0,
  confidence     numeric DEFAULT 1.0,
  metadata       jsonb DEFAULT '{}'::jsonb,
  provenance     jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT health_features_daily_legacy_shadow_unique UNIQUE (tenant_id, user_id, date, feature_key)
);
CREATE INDEX IF NOT EXISTS health_features_daily_legacy_shadow_tenant_user_date_idx
  ON public.health_features_daily_legacy_shadow (tenant_id, user_id, date);

-- 4. health_features_derivation_pending.
CREATE TABLE IF NOT EXISTS public.health_features_derivation_pending (
  tenant_id    uuid NOT NULL,
  user_id      uuid NOT NULL,
  date         date NOT NULL,
  enqueued_at  timestamptz NOT NULL DEFAULT now(),
  attempts     int NOT NULL DEFAULT 0 CONSTRAINT health_features_derivation_pending_attempts_check CHECK (attempts >= 0),
  CONSTRAINT health_features_derivation_pending_key UNIQUE (tenant_id, user_id, date)
);
CREATE INDEX IF NOT EXISTS health_features_derivation_pending_enqueued_idx
  ON public.health_features_derivation_pending (enqueued_at);

-- 5. Service-role only.
ALTER TABLE public.health_features_daily_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_features_daily_legacy_shadow ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_features_derivation_pending ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.health_features_daily_v2 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.health_features_daily_legacy_shadow FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.health_features_derivation_pending FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.health_features_daily_v2 TO service_role;
GRANT ALL ON public.health_features_daily_legacy_shadow TO service_role;
GRANT ALL ON public.health_features_derivation_pending TO service_role;

COMMENT ON TABLE public.health_features_daily_v2 IS
  'VTID-05162: health_features_daily derived from the health store (shadow; B3 compares, B3 cutover publishes). Aurora only. Service role only.';
COMMENT ON TABLE public.health_features_daily_legacy_shadow IS
  'VTID-05162: legacy-shaped health_features_daily rows kept for rollback after B3''s cutover. Empty until then. Aurora only. Service role only.';
COMMENT ON TABLE public.health_features_derivation_pending IS
  'VTID-05162: member-days whose health-store data changed and are not derived into health_features_daily_v2 yet. Aurora only. Service role only.';

COMMIT;
