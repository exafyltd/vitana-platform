-- =============================================================================
-- Drift-proof fix for scheduler_longevity_compute_daily
-- BOOTSTRAP-LONGEVITY-STAGE-FIX  (P0 schema drift)
-- Date: 2026-05-28
--
-- INCIDENT
-- --------
-- Since ~12:38 on 2026-05-28 the daily recompute orchestrator has emitted, on
-- every cycle:
--     stage.longevity.failed: column "id" does not exist
--     daily_recompute.failed  (failed_stage = longevity)
--
-- ROOT CAUSE
-- ----------
-- The stub `scheduler_longevity_compute_daily` resolves a tenant with:
--     SELECT COALESCE(
--         (SELECT tenant_id FROM daily_recompute_runs WHERE ... LIMIT 1),
--         (SELECT id FROM public.tenants LIMIT 1)        <-- offending line
--     ) INTO v_tenant_id;
-- The `(SELECT id FROM public.tenants ...)` fallback raises
-- `column "id" does not exist` (42703), which the function's
-- `EXCEPTION WHEN OTHERS` clause turns into `{ ok:false, error: SQLERRM }`.
-- The orchestrator reads ok=false and marks the stage (and the run) failed.
--
-- WHY THE EARLIER "FIX" (#2348, migration 20260528130000) IS NOT TRUSTED
-- ---------------------------------------------------------------------
-- That migration flipped `id` -> `tenant_id` on a hunch about the real PK.
-- But the canonical bootstrap migration (20251231000000_vtid_01101) defines
-- `public.tenants` with `id UUID PRIMARY KEY` and NO `tenant_id` column. The
-- error is still firing as `"id"` in prod, which means #2348 was never applied
-- and, worse, applying it could simply flip the failure to
-- `column "tenant_id" does not exist`. We refuse to gamble on the live column
-- name of `tenants`.
--
-- THE FIX (non-destructive, drift-proof)
-- --------------------------------------
-- `v_tenant_id` is dead code: it is assigned but never referenced in the
-- function's RETURN value (this is a stub awaiting VTID-01083). So we do NOT
-- need to know the `tenants` PK name at all. We resolve the tenant solely from
-- `daily_recompute_runs.tenant_id` -- a table whose schema is proven-good every
-- cycle (the orchestrator inserts the run row with tenant_id and reads it back
-- before longevity runs). The unverifiable `public.tenants` fallback is
-- removed entirely. No schema change, no CREATE TABLE, no column rename gamble.
--
-- The read-only information_schema dump below records the LIVE `tenants`
-- columns in the workflow log so the actual prod schema is captured for the
-- record (honouring "read information_schema before migrating").
--
-- impact-allow-solo-migration
--   Intentional solo migration with no gateway/worker code change. The
--   orchestrator (services/gateway/src/services/daily-recompute-service.ts)
--   already calls scheduler_longevity_compute_daily via RPC; this migration
--   only replaces the function body. The return shape is unchanged except for
--   an additive `tenant_id` field, so existing callers keep working unmodified.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Read-only diagnostic: capture the ACTUAL prod columns of public.tenants
--    (surfaces in RUN-MIGRATION workflow logs; mutates nothing).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    r RECORD;
    v_found BOOLEAN := false;
BEGIN
    RAISE NOTICE '[longevity-fix] LIVE public.tenants columns:';
    FOR r IN
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tenants'
        ORDER BY ordinal_position
    LOOP
        v_found := true;
        RAISE NOTICE '[longevity-fix]   tenants.% (%)', r.column_name, r.data_type;
    END LOOP;
    IF NOT v_found THEN
        RAISE NOTICE '[longevity-fix]   <no public.tenants table found>';
    END IF;
END $$;

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

    -- Resolve tenant from the run row only. daily_recompute_runs.tenant_id is
    -- written + read by the orchestrator every cycle, so this query is
    -- guaranteed to match the live schema. The previous `(SELECT id FROM
    -- public.tenants LIMIT 1)` fallback is removed -- it depended on an
    -- unverifiable column name and was the source of `column "id" does not
    -- exist`. v_tenant_id is currently unused by the stub return value; it is
    -- retained for the real VTID-01083 implementation.
    SELECT tenant_id INTO v_tenant_id
    FROM public.daily_recompute_runs
    WHERE user_id = p_user_id AND run_date = p_date
    ORDER BY started_at DESC
    LIMIT 1;

    -- STUB: actual longevity computation lives behind VTID-01083.
    v_duration_ms := EXTRACT(MILLISECOND FROM (clock_timestamp() - v_start_time))::INTEGER;

    RETURN jsonb_build_object(
        'ok', true,
        'stage', 'longevity',
        'user_id', p_user_id,
        'date', p_date,
        'tenant_id', v_tenant_id,
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

COMMENT ON FUNCTION public.scheduler_longevity_compute_daily IS
  'VTID-01095/BOOTSTRAP-LONGEVITY-STAGE-FIX: longevity stub. Tenant resolved from daily_recompute_runs only (drift-proof). Real compute awaits VTID-01083.';

NOTIFY pgrst, 'reload schema';

COMMIT;
