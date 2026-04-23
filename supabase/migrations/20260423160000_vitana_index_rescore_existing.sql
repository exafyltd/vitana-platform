-- =============================================================================
-- Vitana Index — one-off rescore of existing users (BOOTSTRAP-VITANA-INDEX-RESCORE)
-- Date: 2026-04-23
-- Plan: .claude/plans/community-user-role-make-purring-pascal.md (step 5)
--
-- Iterates every user with a baseline-survey row and invokes the v3 admin
-- compute RPC for today's date. Users stuck on the pre-v3 (6-pillar or
-- baseline-only) number get moved to the honest v3-5pillar value. Also
-- cleans up stale zero-UUID-tenant duplicate rows that accumulated before
-- the _for_user RPC (which resolves tenant from user_tenants) landed.
--
-- Idempotent: safe to re-run. Each rescore is a SELECT of the RPC; the RPC
-- upserts on (tenant_id, user_id, date).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Rescore all users who have a baseline-survey row.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_user RECORD;
  v_rescored INTEGER := 0;
  v_errors INTEGER := 0;
  v_result JSONB;
BEGIN
  FOR v_user IN
    SELECT DISTINCT user_id
    FROM public.vitana_index_baseline_survey
  LOOP
    BEGIN
      v_result := public.health_compute_vitana_index_for_user(
        v_user.user_id,
        CURRENT_DATE,
        'v3-5pillar-rescore'
      );
      IF (v_result->>'ok')::BOOLEAN THEN
        v_rescored := v_rescored + 1;
      ELSE
        v_errors := v_errors + 1;
        RAISE WARNING 'Rescore returned not-ok for user %: %', v_user.user_id, v_result;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      RAISE WARNING 'Rescore exception for user %: %', v_user.user_id, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE 'Rescore complete: % users updated, % errors', v_rescored, v_errors;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Clean up stale zero-UUID-tenant duplicate rows. If a user has BOTH a
--    zero-UUID row AND a real-tenant row for the same date, the real-tenant
--    row is canonical — delete the zero-UUID one.
-- -----------------------------------------------------------------------------
DELETE FROM public.vitana_index_scores z
USING public.vitana_index_scores real
WHERE z.tenant_id = '00000000-0000-0000-0000-000000000000'::UUID
  AND real.tenant_id <> '00000000-0000-0000-0000-000000000000'::UUID
  AND real.user_id = z.user_id
  AND real.date = z.date;

-- -----------------------------------------------------------------------------
-- 3. Emit an OASIS audit row for the rescoring event. Uses the columns
--    observed in memory (topic, status, source, vtid, metadata).
-- -----------------------------------------------------------------------------
INSERT INTO public.oasis_events (topic, source, status, vtid, metadata, message)
VALUES (
  'index.recalibrated',
  'migration',
  'info',
  'BOOTSTRAP-VITANA-INDEX-RESCORE',
  jsonb_build_object(
    'migration', '20260423160000_vitana_index_rescore_existing.sql',
    'reason', 'Step 5 — move all users to v3-5pillar scoring + clean zero-UUID duplicates'
  ),
  'Vitana Index rescored to v3-5pillar for all users with baseline surveys.'
);

COMMIT;
