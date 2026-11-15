-- Rollback of supabase/migrations/20261115090000_vtid_05800_plan_sparring_gate_off.sql (VTID-05800).
-- Puts the Plan Sparring Gate back exactly as VTID-04868 shipped it: log mode (it records, never blocks), the
-- BEFORE INSERT trigger on vtid_ledger, and the one-VTID-per-sparring-record unique index.
-- The index fails to build if two VTIDs cite the same sparring id by then; find them first with:
--   select metadata->>'sparring_id', array_agg(vtid) from public.vtid_ledger
--    where metadata->>'sparring_id' is not null group by 1 having count(*) > 1;
-- Needs plan_sparring_check() (20261004110000) to exist. Apply only on the owner's instruction (collaboration.md §7d).

BEGIN;

UPDATE public.plan_sparring_config SET mode = 'log', updated_at = now() WHERE id = 1;

CREATE UNIQUE INDEX IF NOT EXISTS vtid_ledger_sparring_id_unique
  ON public.vtid_ledger ((metadata->>'sparring_id'))
  WHERE metadata->>'sparring_id' IS NOT NULL;

DROP TRIGGER IF EXISTS trg_plan_sparring_check ON public.vtid_ledger;
CREATE TRIGGER trg_plan_sparring_check
  BEFORE INSERT ON public.vtid_ledger
  FOR EACH ROW EXECUTE FUNCTION public.plan_sparring_check();

COMMIT;
