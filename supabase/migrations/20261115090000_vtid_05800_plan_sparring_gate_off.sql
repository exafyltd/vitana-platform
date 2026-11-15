-- VTID-05800 — anyone may allocate a VTID: the Plan Sparring Gate leaves the database.
--
-- Owner decision 2026-11-15: "remove all the rules that limit allocation of vtid only through cicd … allocating a vtid
-- should be the easiest thing in the world, manually possible, single click possible, any way that you can imagine
-- should make it possible for any machine any human with any process to allocate a fresh vtid."
--
-- The database half of the Plan Sparring Gate (VTID-04868, 20261004110000 / 20261004120000 / 20261015180000) could
-- refuse a new vtid_ledger row that cites no approved sparring record (mode 'enforce'). This migration removes it:
--   1. DROP the BEFORE INSERT trigger trg_plan_sparring_check, so no insert is ever checked for a sparring record;
--   2. set plan_sparring_config.mode to 'off', so the gate stays inert even if the trigger is ever re-created;
--   3. DROP the partial unique index vtid_ledger_sparring_id_unique, so a sparring id may be cited by any number of
--      VTIDs (PLAN-SPAR allocates one VTID per lane of a converged plan).
-- Unchanged: allocate_global_vtid (p_sparring_id / p_plan_hash stay optional metadata), the sparring tables and their
-- functions (plan review still uses them), and plan_sparring_check() / _plan_sparring_gate_eval(), which nothing calls
-- without the trigger. No row of vtid_ledger is read or changed.
--
-- Idempotent; safe whether the gate migrations were applied or not. Rollback (puts the gate back in log mode):
-- docs/validation/VTID-05800/rollback-20261115090000.sql.

BEGIN;

DROP TRIGGER IF EXISTS trg_plan_sparring_check ON public.vtid_ledger;

DO $$
BEGIN
  IF to_regclass('public.plan_sparring_config') IS NOT NULL THEN
    UPDATE public.plan_sparring_config SET mode = 'off', updated_at = now() WHERE id = 1;
  END IF;
END
$$;

DROP INDEX IF EXISTS public.vtid_ledger_sparring_id_unique;

COMMIT;
