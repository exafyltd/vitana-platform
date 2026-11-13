-- VTID-05041 — close the public execute path of _plan_sparring_gate_eval (SECURITY DEFINER).
-- Migration 20261112100000 replaced the function (bridge period) without a REVOKE; this one adds it, the same
-- REVOKE/GRANT pair as 20261015180000. Function body unchanged. Applied through RUN-MIGRATION after review.
REVOKE ALL ON FUNCTION public._plan_sparring_gate_eval(text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._plan_sparring_gate_eval(text, jsonb, text) TO service_role, vitana_governance_owner;
