BEGIN;
-- VTID-05793: REVOKE on the Plan Sparring gate SECURITY DEFINER function.
--
-- HELD (owner decision, VTID-05041 follow-up): this migration is NOT to be merged, applied or
-- run until the owner approves it. Migrations are human-approved (owner decision 2026-11-12):
-- staging and production share one Supabase project, so this file must never be applied from a
-- session or a workflow without that approval.
--
-- Why: _plan_sparring_gate_eval is SECURITY DEFINER. PUBLIC, anon and authenticated must not
-- hold EXECUTE on it. 20261015180000_vtid_05214_plan_sparring_policy_approval.sql already revokes
-- them, and 20261112100000_bridge_sparring_convergence_is_approval.sql replaces only the body
-- (CREATE OR REPLACE keeps the existing ACL). This statement restates the revoke in its own
-- migration so the lockdown does not depend on that history. It is idempotent: on a database
-- where those roles already lack EXECUTE, it changes nothing.
--
-- Grants are not touched: service_role and vitana_governance_owner keep EXECUTE.
-- impact-allow-solo-migration: a privilege change only, no gateway code reads or writes it.

REVOKE ALL ON FUNCTION public._plan_sparring_gate_eval(text, jsonb, text) FROM PUBLIC, anon, authenticated;

COMMIT;
