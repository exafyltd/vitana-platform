-- =============================================================================
-- Fix longevity stub: tenants.id → tenants.tenant_id
-- BOOTSTRAP-VITANA-INDEX-DAILY follow-up
-- Date: 2026-05-28
--
-- The original stub in 20251231000001_vtid_01095_daily_scheduler.sql referenced
-- `SELECT id FROM public.tenants`, but the column is `tenant_id`. The migration
-- was never applied in prod, so the bug only surfaced once the orchestrator
-- finally ran for real — POST /api/v1/scheduler/daily-recompute returned
-- 5 × "Stage longevity failed: column \"id\" does not exist".
--
-- One-character surgical fix: replace `id` with `tenant_id` in the COALESCE
-- fallback. The Index stage in PIPELINE_STAGES runs before longevity and
-- writes its vitana_index_scores row successfully on every call — this just
-- stops the orchestrator from marking the run as failed on the downstream
-- no-op stub. The stub itself stays a placeholder until VTID-01083 ships
-- the real longevity compute.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.scheduler_longevity_compute_daily(
    p_user_id UUID,
    p_date DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_start_time TIMESTAMPTZ;
    v_duration_ms INTEGER;
BEGIN
    v_start_time := clock_timestamp();

    -- Resolve tenant: prefer the just-inserted daily_recompute_runs row;
    -- fall back to the first tenant if (somehow) no run row exists yet.
    SELECT COALESCE(
        (SELECT tenant_id FROM public.daily_recompute_runs
         WHERE user_id = p_user_id AND run_date = p_date LIMIT 1),
        (SELECT tenant_id FROM public.tenants LIMIT 1)
    ) INTO v_tenant_id;

    -- STUB: actual longevity computation lives behind VTID-01083.
    v_duration_ms := EXTRACT(MILLISECOND FROM (clock_timestamp() - v_start_time))::INTEGER;

    RETURN jsonb_build_object(
        'ok', true,
        'stage', 'longevity',
        'user_id', p_user_id,
        'date', p_date,
        'duration_ms', v_duration_ms,
        'signals_computed', 0,
        'message', 'Longevity compute stub - awaiting VTID-01083 implementation'
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'ok', false,
        'stage', 'longevity',
        'user_id', p_user_id,
        'date', p_date,
        'error', SQLERRM
    );
END;
$$;

REVOKE ALL ON FUNCTION public.scheduler_longevity_compute_daily(UUID, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.scheduler_longevity_compute_daily(UUID, DATE) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
