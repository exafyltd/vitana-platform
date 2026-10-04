-- =============================================================================
-- VTID-04868 ROLLBACK — Plan Sparring Gate DB foundation
-- =============================================================================
-- Reverses supabase/migrations/20261004100000_vtid_04868_plan_sparring_gate.sql.
-- Kept here, NOT under supabase/migrations/, because every file in that folder
-- is a forward migration (RUN-MIGRATION.yml applies whatever it is pointed at,
-- and the drift/RLS scanners parse the whole folder). Apply only with the
-- owner's go, through RUN-MIGRATION.yml's file input or the SQL editor.
--
-- What it does (one transaction):
--   1. Drops the BEFORE INSERT gate on vtid_ledger and its functions.
--   2. Drops the partial unique index on vtid_ledger((metadata->>'sparring_id')).
--   3. Drops the 4-arg allocate_global_vtid and recreates the 3-arg one with
--      the body of 20260628120000_fix_allocate_global_vtid_seq_drift.sql.
--      Grants: EXECUTE to service_role; PUBLIC/anon/authenticated stay revoked
--      (every known caller uses the service role — restoring a public grant
--      would only widen access).
--   4. Drops submit_plan_sparring_record / plan_sparring_append_round and the
--      break-glass ledger policy + grants.
--   5. KEEPS the three plan_sparring_* tables and the vitana_governance_owner
--      role, so the sparring records and shadow log survive as evidence. To
--      remove them too, run the optional block at the end.
-- Ledger rows keep any metadata.sparring_id / sparring_id_unverified keys;
-- they are inert without the gate.
-- Tested on a throwaway Postgres by scripts/ci/test-vtid-04868-plan-sparring.sh.
-- =============================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_plan_sparring_check ON public.vtid_ledger;
DROP FUNCTION IF EXISTS public.plan_sparring_trigger_status();
DROP FUNCTION IF EXISTS public.plan_sparring_check();
DROP FUNCTION IF EXISTS public._plan_sparring_gate_eval(text, jsonb, text);
DROP FUNCTION IF EXISTS public._plan_sparring_mode();
DROP INDEX IF EXISTS public.vtid_ledger_sparring_id_unique;

DROP FUNCTION IF EXISTS public.submit_plan_sparring_record(uuid, text, text, text, jsonb, text, text, jsonb, text[]);
DROP FUNCTION IF EXISTS public.plan_sparring_append_round(uuid, jsonb);

DROP POLICY IF EXISTS vtid_ledger_governance_owner_insert ON public.vtid_ledger;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vitana_governance_owner') THEN
    REVOKE INSERT ON public.vtid_ledger FROM vitana_governance_owner;
    REVOKE USAGE ON SEQUENCE public.global_vtid_seq FROM vitana_governance_owner;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.allocate_global_vtid(text, text, text, uuid);

CREATE OR REPLACE FUNCTION public.allocate_global_vtid(
    p_source TEXT DEFAULT 'api',
    p_layer TEXT DEFAULT 'DEV',
    p_module TEXT DEFAULT 'TASK'
)
RETURNS TABLE(vtid TEXT, num BIGINT, id TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_num BIGINT;
    v_vtid TEXT;
    v_id TEXT;
    v_layer TEXT;
    v_module TEXT;
    v_found BOOLEAN := false;
BEGIN
    -- Normalize inputs
    v_layer := UPPER(COALESCE(p_layer, 'DEV'));
    v_module := UPPER(COALESCE(p_module, 'TASK'));

    -- Step 1: Find the next FREE sequence number.
    FOR i IN 1..1000 LOOP
        v_num := nextval('global_vtid_seq');
        v_vtid := 'VTID-' || LPAD(v_num::TEXT, 5, '0');
        IF NOT EXISTS (SELECT 1 FROM vtid_ledger WHERE vtid_ledger.vtid = v_vtid) THEN
            v_found := true;
            EXIT;
        END IF;
    END LOOP;

    IF NOT v_found THEN
        RAISE EXCEPTION 'allocate_global_vtid: no free VTID slot found in 1000 tries (sequence at %)', v_num
            USING ERRCODE = 'unique_violation';
    END IF;

    -- Step 2: Generate UUID for the row
    v_id := gen_random_uuid()::TEXT;

    -- Step 3: Insert shell entry into vtid_ledger (same shape as before)
    INSERT INTO vtid_ledger (
        id, vtid, title, status, tenant, layer, module, task_family, task_type,
        summary, description, is_test, metadata, created_at, updated_at
    ) VALUES (
        v_id, v_vtid, 'Allocated - Pending Title', 'allocated', 'vitana',
        v_layer, v_module, v_layer, v_module, '', '', false,
        jsonb_build_object(
            'source', p_source,
            'allocated_at', NOW()::TEXT,
            'allocator_version', 'VTID-0542'
        ),
        NOW(), NOW()
    );

    RETURN QUERY SELECT v_vtid, v_num, v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.allocate_global_vtid(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_global_vtid(TEXT, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION public.allocate_global_vtid(TEXT, TEXT, TEXT) IS
    'VTID-0542: Atomically allocates next FREE VTID and creates a shell entry in vtid_ledger. Uses a bounded skip-forward loop so it tolerates sequence drift caused by out-of-band VTID writers.';

COMMIT;

NOTIFY pgrst, 'reload schema';

-- -----------------------------------------------------------------------------
-- OPTIONAL (destroys the sparring records and the shadow log). Run separately,
-- only if the evidence is no longer wanted:
--
-- BEGIN;
-- DROP TABLE IF EXISTS public.plan_sparring_shadow_log;
-- DROP TABLE IF EXISTS public.plan_sparring_config;
-- DROP TABLE IF EXISTS public.plan_sparring_sessions;
-- DROP FUNCTION IF EXISTS public._plan_sparring_sessions_touch();
-- DROP ROLE IF EXISTS vitana_governance_owner;
-- COMMIT;
-- -----------------------------------------------------------------------------
