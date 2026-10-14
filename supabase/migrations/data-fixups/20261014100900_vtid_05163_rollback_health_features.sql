-- VTID-05163 (Health Hub Phase 1 / B3) — ROLLBACK of a health_features_daily
-- cutover (plan docs/validation/VTID-05163/plan-sparring.md, B Change 14).
--
-- NOT PART OF ANY DEPLOY. Prepared and reviewed with the cutover PR; used ONLY
-- if a post-cutover check fails. It is a production write the two owner gates
-- do not cover: only the owner runs it, or the owner records an authorization
-- for ONE named session in docs/validation/<VTID>/rollback.md (time + reason).
-- Applied only through the approved migration path of the database that holds
-- health_features_daily_legacy_shadow (Aurora, after the cutover), never as
-- ad-hoc SQL.
--
-- Order (Change 14c): 1. set HEALTH_FEATURES_SOURCE back to `legacy` (a
-- config-only prod deploy pinned to the same commit) so no new derived rows
-- appear; 2. apply THIS file; 3. run the existing daily Index stage for the
-- affected members; 4. the read-only verification query at the bottom, result
-- into the rollback record.
--
-- Parameters (session settings, both REQUIRED — the file refuses to run
-- without them, so it can never run with a guessed scope):
--   SET vitana.health_features_rollback_mode = 'derived_device' | 'derived';
--   SET vitana.health_features_rollback_date = 'YYYY-MM-DD';   -- C, the cutover date
-- The operator passes them as session settings (e.g. PGOPTIONS='-c
-- vitana.health_features_rollback_mode=derived_device -c
-- vitana.health_features_rollback_date=2026-11-01'); the values used are
-- recorded in docs/validation/<VTID>/rollback.md.
--
-- What it does, in ONE transaction, for dates >= C and the keys of the mode:
--   a. copies health_features_daily_legacy_shadow rows over health_features_daily
--      (ON CONFLICT (tenant_id, user_id, date, feature_key) DO UPDATE);
--   b. deletes metadata.source = 'derived_v2' rows that have no shadow
--      counterpart;
--   c. post-condition guard: every shadow row in scope has an identical
--      health_features_daily row and no derived_v2 row remains in scope —
--      otherwise RAISE EXCEPTION, which rolls back a. and b. as well.
-- Keys per mode (must equal services/gateway/src/services/health-features/
-- feature-spec.ts — a Jest test reads this file):
--   derived_device: the seven device keys;
--   derived:        every key with a store code (device keys + meal_log,
--                   water_intake, mood_entry, meditation_minutes).
-- biomarker_* and the other un-coded keys are never cut over, so never touched.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $rollback$
DECLARE
  v_mode text := nullif(current_setting('vitana.health_features_rollback_mode', true), '');
  v_date_txt text := nullif(current_setting('vitana.health_features_rollback_date', true), '');
  v_date date;
  v_keys text[];
  v_copied int;
  v_deleted int;
  v_missing int;
  v_left int;
BEGIN
  IF to_regclass('public.health_features_daily_legacy_shadow') IS NULL THEN
    RAISE EXCEPTION 'VTID-05163 rollback: health_features_daily_legacy_shadow does not exist in this database (wrong target).';
  END IF;
  IF v_mode IS NULL OR v_mode NOT IN ('derived_device', 'derived') THEN
    RAISE EXCEPTION 'VTID-05163 rollback: SET vitana.health_features_rollback_mode to derived_device or derived (got %).', coalesce(v_mode, 'nothing');
  END IF;
  IF v_date_txt IS NULL OR v_date_txt !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'VTID-05163 rollback: SET vitana.health_features_rollback_date to the cutover date C, YYYY-MM-DD (got %).', coalesce(v_date_txt, 'nothing');
  END IF;
  v_date := v_date_txt::date;

  v_keys := ARRAY['wearable_heart_rate','wearable_steps','wearable_workout','vo2_max',
                  'wearable_sleep_duration','wearable_sleep_efficiency','wearable_hrv'];
  IF v_mode = 'derived' THEN
    v_keys := v_keys || ARRAY['meal_log','water_intake','mood_entry','meditation_minutes'];
  END IF;

  -- a. shadow over live.
  INSERT INTO public.health_features_daily
         (tenant_id, user_id, date, feature_key, feature_value, feature_unit, sample_count, confidence, metadata, updated_at)
  SELECT s.tenant_id, s.user_id, s.date, s.feature_key, s.feature_value, s.feature_unit, s.sample_count, s.confidence,
         coalesce(s.metadata, '{}'::jsonb), now()
    FROM public.health_features_daily_legacy_shadow s
   WHERE s.date >= v_date AND s.feature_key = ANY (v_keys)
  ON CONFLICT (tenant_id, user_id, date, feature_key) DO UPDATE SET
         feature_value = EXCLUDED.feature_value,
         feature_unit  = EXCLUDED.feature_unit,
         sample_count  = EXCLUDED.sample_count,
         confidence    = EXCLUDED.confidence,
         metadata      = EXCLUDED.metadata,
         updated_at    = EXCLUDED.updated_at;
  GET DIAGNOSTICS v_copied = ROW_COUNT;

  -- b. derived rows with no shadow counterpart.
  DELETE FROM public.health_features_daily h
   WHERE h.date >= v_date AND h.feature_key = ANY (v_keys)
     AND h.metadata ->> 'source' = 'derived_v2'
     AND NOT EXISTS (SELECT 1 FROM public.health_features_daily_legacy_shadow s
                      WHERE s.tenant_id = h.tenant_id AND s.user_id = h.user_id
                        AND s.date = h.date AND s.feature_key = h.feature_key);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- c. post-condition guard (inside the transaction).
  SELECT count(*) INTO v_missing
    FROM public.health_features_daily_legacy_shadow s
   WHERE s.date >= v_date AND s.feature_key = ANY (v_keys)
     AND NOT EXISTS (SELECT 1 FROM public.health_features_daily h
                      WHERE h.tenant_id = s.tenant_id AND h.user_id = s.user_id
                        AND h.date = s.date AND h.feature_key = s.feature_key
                        AND h.feature_value = s.feature_value
                        AND h.metadata IS NOT DISTINCT FROM coalesce(s.metadata, '{}'::jsonb));
  SELECT count(*) INTO v_left
    FROM public.health_features_daily h
   WHERE h.date >= v_date AND h.feature_key = ANY (v_keys)
     AND h.metadata ->> 'source' = 'derived_v2';
  IF v_missing <> 0 OR v_left <> 0 THEN
    RAISE EXCEPTION 'VTID-05163 rollback post-condition failed (shadow rows not restored: %, derived_v2 rows left: %) — nothing was changed.', v_missing, v_left;
  END IF;

  RAISE NOTICE 'VTID-05163 rollback (% from %): % shadow rows restored, % derived_v2 rows deleted.', v_mode, v_date, v_copied, v_deleted;
END
$rollback$;

COMMIT;

-- Read-only verification afterwards (Change 14d) — run separately, result into
-- the rollback record. Both counts must be 0.
--   SELECT
--     (SELECT count(*) FROM public.health_features_daily_legacy_shadow s
--       WHERE s.date >= :'C' AND s.feature_key = ANY (:'KEYS'::text[])
--         AND NOT EXISTS (SELECT 1 FROM public.health_features_daily h
--                          WHERE (h.tenant_id, h.user_id, h.date, h.feature_key) = (s.tenant_id, s.user_id, s.date, s.feature_key)
--                            AND h.feature_value = s.feature_value)) AS shadow_rows_not_live,
--     (SELECT count(*) FROM public.health_features_daily h
--       WHERE h.date >= :'C' AND h.feature_key = ANY (:'KEYS'::text[])
--         AND h.metadata ->> 'source' = 'derived_v2') AS derived_rows_left;
