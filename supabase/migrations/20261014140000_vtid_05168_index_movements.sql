-- =============================================================================
-- VTID-05168 — Life Timeline P2: record what moves the Vitana Index.
-- Sparring record: docs/validation/VTID-05167/plan-sparring.md (§4, F10, F11,
-- F13, F15; plan hash 535ddb70…2b04, CONVERGED, owner-approved 2026-10-13).
--
-- Before this migration nothing recorded WHY the Index moved:
-- vitana_index_scores is one upserted row per member per day, and most
-- recompute paths emitted no delta at all.
--
-- What this does (no change to the scoring formula — the existing body is
-- renamed, never copied):
--   1. vitana_index_movements: one row per recompute that changed something —
--      before/after per pillar, delta_total, delta_pillars, balance factor
--      before/after, the trigger and the source (e.g. calendar_event <id>).
--      Owner-read RLS; written only by the definer function below.
--   2. health_compute_vitana_index_for_user(uuid,date,text) is RENAMED to
--      health_compute_vitana_index_core (body untouched); EXECUTE for
--      service_role only.
--   3. vitana_index_recompute_and_record(user, date, trigger, source_kind,
--      source_ref, model_version): ONE transaction —
--      pg_advisory_xact_lock(per member) → read before → core → read after →
--      insert a movement only if a score changed (or it is the member's first
--      score). "Before" is today's row, else the latest earlier row, so the
--      first recompute of a day records the change since the previous day.
--      The lock serialises every recompute of one member, so two
--      near-simultaneous entries each get their own correct delta (F10).
--   4. Every writer goes through (3):
--      - health_compute_vitana_index_for_user(uuid,date,text) is re-created
--        under its old name as a thin wrapper (trigger 'unspecified'), so any
--        caller not yet converted is still locked and recorded;
--      - scheduler_vitana_index_compute_daily → trigger 'daily' (F13);
--      - the calendar completion trigger → 'calendar_completion' with the
--        event id;
--      - the member-callable overloads health_compute_vitana_index(date,text)
--        and (date) stay SECURITY DEFINER with their existing authenticated
--        grant, resolve auth.uid() themselves and call (3) with 'self_heal'.
--        They now score with the canonical formula (community tags count for
--        Mental — owner decision D4). Response shapes are kept (F11).
--      The gateway's direct baseline-survey upsert is removed in the same PR
--      (F15); a CI guard fails if gateway code writes vitana_index_scores.
--
-- Rollback (restores the pre-VTID-05168 functions; movements table can stay):
--   docs/validation/VTID-05168/rollback.sql
-- =============================================================================

BEGIN;

-- 1. Movements -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vitana_index_movements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid,
  user_id        uuid NOT NULL,
  at             timestamptz NOT NULL DEFAULT now(),
  score_date     date NOT NULL,
  trigger        text NOT NULL,
  source_kind    text,
  source_ref     text,
  before         jsonb,
  after          jsonb NOT NULL,
  delta_total    integer NOT NULL,
  delta_pillars  jsonb NOT NULL,
  balance_before numeric,
  balance_after  numeric
);

CREATE INDEX IF NOT EXISTS idx_vim_user_at ON public.vitana_index_movements (user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_vim_user_source ON public.vitana_index_movements (user_id, source_kind, source_ref)
  WHERE source_ref IS NOT NULL;

ALTER TABLE public.vitana_index_movements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vitana_index_movements_owner_read ON public.vitana_index_movements;
CREATE POLICY vitana_index_movements_owner_read ON public.vitana_index_movements
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
REVOKE ALL ON public.vitana_index_movements FROM anon, authenticated;
GRANT SELECT ON public.vitana_index_movements TO authenticated;

COMMENT ON TABLE public.vitana_index_movements IS
  'VTID-05168: one row per Vitana Index recompute that changed a score. Written only by vitana_index_recompute_and_record(). Timeline influence badges read it; never invent a delta that is not here.';

-- 2. Rename the canonical body (idempotent) -----------------------------------
DO $rename$
BEGIN
  IF to_regprocedure('public.health_compute_vitana_index_core(uuid,date,text)') IS NULL THEN
    ALTER FUNCTION public.health_compute_vitana_index_for_user(uuid, date, text)
      RENAME TO health_compute_vitana_index_core;
  END IF;
END
$rename$;

REVOKE ALL ON FUNCTION public.health_compute_vitana_index_core(uuid, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.health_compute_vitana_index_core(uuid, date, text) FROM anon, authenticated;
DO $m$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migrate') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.health_compute_vitana_index_core(uuid, date, text) FROM migrate';
  END IF;
END $m$;
GRANT EXECUTE ON FUNCTION public.health_compute_vitana_index_core(uuid, date, text) TO service_role;

-- 3. The single locked writer --------------------------------------------------
CREATE OR REPLACE FUNCTION public.vitana_index_recompute_and_record(
  p_user_id       uuid,
  p_date          date,
  p_trigger       text,
  p_source_kind   text DEFAULT NULL,
  p_source_ref    text DEFAULT NULL,
  p_model_version text DEFAULT 'v3-5pillar'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before   public.vitana_index_scores;
  v_after    public.vitana_index_scores;
  v_result   jsonb;
  v_b        jsonb;
  v_a        jsonb;
  v_dp       jsonb;
  v_changed  boolean;
  v_move_id  uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'USER_ID_REQUIRED');
  END IF;
  IF p_trigger IS NULL OR p_trigger !~ '^[a-z][a-z0-9_]{1,40}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_TRIGGER');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('vitana_index:' || p_user_id::text, 0));

  SELECT * INTO v_before
    FROM public.vitana_index_scores
   WHERE user_id = p_user_id AND date <= p_date
   ORDER BY date DESC, updated_at DESC NULLS LAST
   LIMIT 1;

  v_result := public.health_compute_vitana_index_core(p_user_id, p_date, COALESCE(p_model_version, 'v3-5pillar'));
  IF NOT COALESCE((v_result->>'ok')::boolean, false) THEN
    RETURN v_result;
  END IF;

  SELECT * INTO v_after
    FROM public.vitana_index_scores
   WHERE user_id = p_user_id AND date = p_date
   ORDER BY updated_at DESC NULLS LAST
   LIMIT 1;
  IF v_after.user_id IS NULL THEN
    RETURN v_result;
  END IF;

  v_a := jsonb_build_object(
    'score_total', v_after.score_total, 'nutrition', v_after.score_nutrition,
    'hydration', v_after.score_hydration, 'exercise', v_after.score_exercise,
    'sleep', v_after.score_sleep, 'mental', v_after.score_mental);
  IF v_before.user_id IS NOT NULL THEN
    v_b := jsonb_build_object(
      'score_total', v_before.score_total, 'nutrition', v_before.score_nutrition,
      'hydration', v_before.score_hydration, 'exercise', v_before.score_exercise,
      'sleep', v_before.score_sleep, 'mental', v_before.score_mental, 'date', v_before.date);
  END IF;

  v_dp := jsonb_build_object(
    'nutrition', v_after.score_nutrition - COALESCE(v_before.score_nutrition, 0),
    'hydration', v_after.score_hydration - COALESCE(v_before.score_hydration, 0),
    'exercise',  v_after.score_exercise  - COALESCE(v_before.score_exercise, 0),
    'sleep',     v_after.score_sleep     - COALESCE(v_before.score_sleep, 0),
    'mental',    v_after.score_mental    - COALESCE(v_before.score_mental, 0));

  v_changed := v_before.user_id IS NULL
    OR v_after.score_total     IS DISTINCT FROM v_before.score_total
    OR v_after.score_nutrition IS DISTINCT FROM v_before.score_nutrition
    OR v_after.score_hydration IS DISTINCT FROM v_before.score_hydration
    OR v_after.score_exercise  IS DISTINCT FROM v_before.score_exercise
    OR v_after.score_sleep     IS DISTINCT FROM v_before.score_sleep
    OR v_after.score_mental    IS DISTINCT FROM v_before.score_mental;

  IF v_changed THEN
    INSERT INTO public.vitana_index_movements
      (tenant_id, user_id, score_date, trigger, source_kind, source_ref, before, after,
       delta_total, delta_pillars, balance_before, balance_after)
    VALUES
      (v_after.tenant_id, p_user_id, p_date, p_trigger, p_source_kind, p_source_ref, v_b, v_a,
       v_after.score_total - COALESCE(v_before.score_total, 0), v_dp,
       NULLIF(v_before.feature_inputs->>'balance_factor', '')::numeric,
       NULLIF(v_after.feature_inputs->>'balance_factor', '')::numeric)
    RETURNING id INTO v_move_id;
  END IF;

  RETURN v_result || jsonb_build_object(
    'movement_id', v_move_id,
    'delta_total', CASE WHEN v_changed THEN v_after.score_total - COALESCE(v_before.score_total, 0) ELSE 0 END,
    'per_pillar_delta', CASE WHEN v_changed THEN v_dp
                             ELSE jsonb_build_object('nutrition',0,'hydration',0,'exercise',0,'sleep',0,'mental',0) END,
    'prior_score_total', v_before.score_total);
END;
$$;

REVOKE ALL ON FUNCTION public.vitana_index_recompute_and_record(uuid, date, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.vitana_index_recompute_and_record(uuid, date, text, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vitana_index_recompute_and_record(uuid, date, text, text, text, text) TO service_role;

-- 4a. Old name, thin wrapper (any unconverted caller stays locked + recorded) --
CREATE OR REPLACE FUNCTION public.health_compute_vitana_index_for_user(
  p_user_id uuid, p_date date, p_model_version text DEFAULT 'v3-5pillar'
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.vitana_index_recompute_and_record(p_user_id, p_date, 'unspecified', NULL, NULL, p_model_version)
$$;

REVOKE ALL ON FUNCTION public.health_compute_vitana_index_for_user(uuid, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.health_compute_vitana_index_for_user(uuid, date, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.health_compute_vitana_index_for_user(uuid, date, text) TO service_role;

-- 4b. Nightly scheduler → trigger 'daily' (body otherwise unchanged) ------------
CREATE OR REPLACE FUNCTION public.scheduler_vitana_index_compute_daily(p_user_id uuid, p_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start_time  timestamptz;
  v_duration_ms integer;
  v_result      jsonb;
BEGIN
  v_start_time := clock_timestamp();
  v_result := public.vitana_index_recompute_and_record(p_user_id, p_date, 'daily', 'scheduler', NULL, 'v3-5pillar');
  v_duration_ms := EXTRACT(MILLISECOND FROM (clock_timestamp() - v_start_time))::integer;
  IF COALESCE((v_result->>'ok')::boolean, false) THEN
    RETURN jsonb_build_object('ok', true, 'stage', 'index', 'user_id', p_user_id, 'date', p_date,
      'duration_ms', v_duration_ms, 'score_total', v_result->'score_total', 'model_version', v_result->'model_version');
  END IF;
  RETURN jsonb_build_object('ok', false, 'stage', 'index', 'user_id', p_user_id, 'date', p_date,
    'duration_ms', v_duration_ms, 'error', COALESCE(v_result->>'error', 'INDEX_COMPUTE_FAILED'));
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'stage', 'index', 'user_id', p_user_id, 'date', p_date, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.scheduler_vitana_index_compute_daily(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.scheduler_vitana_index_compute_daily(uuid, date) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scheduler_vitana_index_compute_daily(uuid, date) TO service_role;

-- 4c. Calendar completion trigger → 'calendar_completion' + event id -----------
CREATE OR REPLACE FUNCTION public.vitana_trg_calendar_completion_recompute()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.completion_status = 'completed'
     AND (OLD.completion_status IS DISTINCT FROM 'completed')
     AND NEW.user_id IS NOT NULL
  THEN
    BEGIN
      PERFORM public.vitana_index_recompute_and_record(
        NEW.user_id, CURRENT_DATE, 'calendar_completion', 'calendar_event', NEW.id::text, 'v3-5pillar');
    EXCEPTION WHEN OTHERS THEN
      -- Never block a calendar update on a recompute failure.
      RAISE WARNING 'vitana recompute on completion failed: %', SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.vitana_trg_calendar_completion_recompute() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.vitana_trg_calendar_completion_recompute() FROM anon, authenticated;

-- 4d. Member-callable overloads: same grants and shapes, canonical formula -----
CREATE OR REPLACE FUNCTION public.health_compute_vitana_index(p_date date, p_model_version text DEFAULT 'v3-5pillar')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_result  jsonb;
  v_row     public.vitana_index_scores;
  v_weights jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  END IF;
  v_result := public.vitana_index_recompute_and_record(v_user_id, p_date, 'self_heal', 'member_rpc', NULL, p_model_version);
  IF NOT COALESCE((v_result->>'ok')::boolean, false) THEN
    RETURN v_result;
  END IF;
  SELECT * INTO v_row FROM public.vitana_index_scores
   WHERE user_id = v_user_id AND date = p_date ORDER BY updated_at DESC NULLS LAST LIMIT 1;
  SELECT pillar_weights INTO v_weights FROM public.vitana_index_config
   WHERE is_active = TRUE ORDER BY version DESC LIMIT 1;
  RETURN (v_result - 'user_id' - 'movement_id' - 'per_pillar_delta' - 'prior_score_total' - 'delta_total')
    || jsonb_build_object(
      'raw_sum', v_row.feature_inputs->'raw_sum',
      'ratio', v_row.feature_inputs->'ratio',
      'pillar_weights', jsonb_build_object(
        'nutrition', COALESCE((v_weights->>'nutrition')::numeric, 1.0),
        'hydration', COALESCE((v_weights->>'hydration')::numeric, 1.0),
        'exercise',  COALESCE((v_weights->>'exercise')::numeric, 1.0),
        'sleep',     COALESCE((v_weights->>'sleep')::numeric, 1.0),
        'mental',    COALESCE((v_weights->>'mental')::numeric, 1.0)));
END;
$$;

REVOKE ALL ON FUNCTION public.health_compute_vitana_index(date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.health_compute_vitana_index(date, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.health_compute_vitana_index(date, text) TO authenticated, service_role;

-- The live function has DEFAULT CURRENT_DATE; CREATE OR REPLACE may not drop a default (42P13).
CREATE OR REPLACE FUNCTION public.health_compute_vitana_index(p_date date DEFAULT CURRENT_DATE)
RETURNS TABLE(user_id uuid, score_total integer, score_nutrition integer, score_hydration integer,
              score_exercise integer, score_sleep integer, score_mental integer, confidence numeric,
              model_version text, feature_inputs jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_result  jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  v_result := public.vitana_index_recompute_and_record(v_user_id, p_date, 'self_heal', 'member_rpc', NULL, 'v3-5pillar');
  IF NOT COALESCE((v_result->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'INDEX_COMPUTE_FAILED: %', COALESCE(v_result->>'error', 'unknown');
  END IF;
  RETURN QUERY
    SELECT s.user_id, s.score_total, s.score_nutrition, s.score_hydration, s.score_exercise,
           s.score_sleep, s.score_mental, s.confidence, s.model_version, s.feature_inputs
      FROM public.vitana_index_scores s
     WHERE s.user_id = v_user_id AND s.date = p_date
     ORDER BY s.updated_at DESC NULLS LAST
     LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.health_compute_vitana_index(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.health_compute_vitana_index(date) FROM anon;
GRANT EXECUTE ON FUNCTION public.health_compute_vitana_index(date) TO authenticated, service_role;

COMMIT;
