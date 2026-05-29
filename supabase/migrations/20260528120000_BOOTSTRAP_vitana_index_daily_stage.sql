-- =============================================================================
-- Daily Recompute Pipeline — Vitana Index stage (BOOTSTRAP-VITANA-INDEX-DAILY)
-- Date: 2026-05-28
--
-- The Vitana Index `vitana_index_scores` table is only written when activity
-- events fire (calendar completion, health log, integration, voice tool).
-- The existing daily recompute pipeline (VTID-01095) has stages for
-- longevity / topics / community_recs / matches but no stage that writes a
-- fresh per-user Index row, so an inactive day leaves the trailing window
-- empty and downstream surfaces (native app, voice, profile cards) show 0.
--
-- This migration adds the missing pipeline stage. It wraps the existing
-- `health_compute_vitana_index_for_user(user, date, model_version)` RPC and
-- reshapes its return into the `{ ok, stage, user_id, date, ... }` envelope
-- the orchestrator expects (see executeStage() in
-- services/gateway/src/services/daily-recompute-service.ts).
--
-- Grants follow the existing pattern: service_role only (this RPC is invoked
-- from the gateway with the service-role key).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.scheduler_vitana_index_compute_daily(
    p_user_id UUID,
    p_date DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_start_time TIMESTAMPTZ;
    v_duration_ms INTEGER;
    v_result JSONB;
    v_ok BOOLEAN;
BEGIN
    v_start_time := clock_timestamp();

    v_result := public.health_compute_vitana_index_for_user(
        p_user_id,
        p_date,
        'v3-5pillar'
    );

    v_duration_ms := EXTRACT(MILLISECOND FROM (clock_timestamp() - v_start_time))::INTEGER;
    v_ok := COALESCE((v_result->>'ok')::BOOLEAN, FALSE);

    IF v_ok THEN
        RETURN jsonb_build_object(
            'ok', true,
            'stage', 'index',
            'user_id', p_user_id,
            'date', p_date,
            'duration_ms', v_duration_ms,
            'score_total', v_result->'score_total',
            'model_version', v_result->'model_version'
        );
    ELSE
        RETURN jsonb_build_object(
            'ok', false,
            'stage', 'index',
            'user_id', p_user_id,
            'date', p_date,
            'duration_ms', v_duration_ms,
            'error', COALESCE(v_result->>'error', 'INDEX_COMPUTE_FAILED')
        );
    END IF;
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'ok', false,
        'stage', 'index',
        'user_id', p_user_id,
        'date', p_date,
        'error', SQLERRM
    );
END;
$$;

REVOKE ALL ON FUNCTION public.scheduler_vitana_index_compute_daily(UUID, DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.scheduler_vitana_index_compute_daily(UUID, DATE) FROM authenticated;
REVOKE ALL ON FUNCTION public.scheduler_vitana_index_compute_daily(UUID, DATE) FROM anon;
GRANT EXECUTE ON FUNCTION public.scheduler_vitana_index_compute_daily(UUID, DATE) TO service_role;

COMMENT ON FUNCTION public.scheduler_vitana_index_compute_daily(UUID, DATE) IS
  'Daily-recompute pipeline stage that writes a fresh vitana_index_scores row for the given user/date by delegating to health_compute_vitana_index_for_user. Returns the standard stage envelope { ok, stage, user_id, date, duration_ms, ... }.';

NOTIFY pgrst, 'reload schema';

COMMIT;
