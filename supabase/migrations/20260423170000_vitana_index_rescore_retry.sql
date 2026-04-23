-- =============================================================================
-- Vitana Index — rescore retry (audit insert removed)
-- Date: 2026-04-23
--
-- Previous rescore migration (20260423160000) ran the DO block + cleanup but
-- the oasis_events audit INSERT failed (service column NOT NULL) which
-- aborted the transaction, so the rescore changes were rolled back. This
-- retry drops the audit insert and keeps the rescore + cleanup.
-- Idempotent.
-- =============================================================================

BEGIN;

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
        RAISE WARNING 'Rescore not-ok for user %: %', v_user.user_id, v_result;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      RAISE WARNING 'Rescore exception for user %: %', v_user.user_id, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE 'Rescore retry complete: % users updated, % errors', v_rescored, v_errors;
END $$;

DELETE FROM public.vitana_index_scores z
USING public.vitana_index_scores real
WHERE z.tenant_id = '00000000-0000-0000-0000-000000000000'::UUID
  AND real.tenant_id <> '00000000-0000-0000-0000-000000000000'::UUID
  AND real.user_id = z.user_id
  AND real.date = z.date;

COMMIT;
