-- VTID-05575 (mt-network-r2/matching-intent-scope-db) M3: the intent matchers stop defaulting to "everyone".
--
-- Today the four matchers - search_intent_catalog, search_intent_catalog_v2, compute_intent_matches, compute_intent_matches_v2 -
-- build their candidate pool with  (ui.tenant_id = <caller tenant> OR p_visibility = 'public')  and
-- (ui.tenant_id = src.tenant_id OR src.visibility = 'public'). The search functions DEFAULT p_visibility to 'public', and so does
-- the gateway (intent-find-match.ts passes 'public'), so a Find-a-Match search reaches every member of every community.
--
-- After this file (D15; network pool = network_visible only):
--   * p_visibility is the caller's SCOPE and defaults to 'community': candidates come from the caller's own tenant only.
--   * 'network' (and the legacy explicit 'public', which now means the same) adds candidates of other tenants - but only members
--     who opted in (public.is_network_candidate: network_visible, and not a service bot, notification test actor or
--     platform-only account - rules 43-45).
--   * compute_intent_matches(_v2) has no p_visibility parameter: the source intent's own visibility picks the scope
--     ('public' -> network rule, anything else -> community).
-- No scoring changes. The only edit to each function is the pool predicate (through the new public.intent_pool_allows) and, for
-- the two search functions, the parameter default. The Vitana Index never enters these matchers (their reasons are
-- location/time/activity/profile fit), so D25 needs nothing here; the health-reason filter for daily_matches is 20261102053100.
--
-- HOW: each live function is read with pg_get_functiondef(), the two predicates and the default are replaced as text, and the result
-- is CREATE OR REPLACEd, so the file cannot drift from the live body (the bodies differ by embedding column and are re-captured
-- by every migration). If a present function contains none of the expected predicates the file raises and changes nothing.
-- CREATE OR REPLACE keeps owner and grants. A function that does not exist is skipped. Re-running is a no-op.
--
-- Depends on 20261102053100 (is_network_candidate) and VTID-05582. Rollback: docs/validation/VTID-05575/rollback-053200-intent-matchers-scope.sql
-- Registering the matchers in the lineage-guard inventory is mt-guardrails-r2's list (stated dependency, not duplicated here).

-- impact-allow-solo-migration: replaces four functions in place with a one-predicate change; the callers keep their signatures.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- p_cand_tenant/p_cand_user: the candidate intent's tenant and requester; p_src_tenant: the caller's tenant; p_scope: community | network | public.
CREATE OR REPLACE FUNCTION public.intent_pool_allows(p_cand_tenant uuid, p_src_tenant uuid, p_cand_user uuid, p_scope text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF p_cand_tenant IS NOT NULL AND p_cand_tenant = p_src_tenant THEN
    RETURN true;
  END IF;
  IF lower(coalesce(p_scope, '')) IN ('network', 'public') THEN
    RETURN public.is_network_candidate(p_cand_user);
  END IF;
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.intent_pool_allows(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intent_pool_allows(uuid, uuid, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intent_pool_allows(uuid, uuid, uuid, text) TO service_role;

DO $mig$
DECLARE
  v_sig text;
  v_oid oid;
  v_old text;
  v_new text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.search_intent_catalog(uuid,uuid,text,text,jsonb,text,text,integer)',
    'public.search_intent_catalog_v2(uuid,uuid,text,text,jsonb,text,text,integer)',
    'public.compute_intent_matches(uuid,integer)',
    'public.compute_intent_matches_v2(uuid,integer)'
  ] LOOP
    v_oid := to_regprocedure(v_sig);
    IF v_oid IS NULL THEN
      RAISE NOTICE 'VTID-05575: % is absent; skipped', v_sig;
      CONTINUE;
    END IF;
    v_old := pg_get_functiondef(v_oid);
    IF position('intent_pool_allows' IN v_old) > 0 THEN
      CONTINUE;  -- already scoped
    END IF;

    v_new := replace(v_old, '(ui.tenant_id = p_tenant_id OR p_visibility = ''public'')',
                     'public.intent_pool_allows(ui.tenant_id, p_tenant_id, ui.requester_user_id, p_visibility)');
    v_new := replace(v_new, '(ui.tenant_id = src.tenant_id OR src.visibility = ''public'')',
                     'public.intent_pool_allows(ui.tenant_id, src.tenant_id, ui.requester_user_id, CASE WHEN src.visibility = ''public'' THEN ''network'' ELSE ''community'' END)');
    v_new := replace(v_new, 'p_visibility text DEFAULT ''public''::text', 'p_visibility text DEFAULT ''community''::text');

    IF v_new = v_old OR v_new ~ 'OR (p_visibility|src\.visibility) = ''public''\)' THEN
      RAISE EXCEPTION 'VTID-05575: % does not have the expected pool predicate; nothing changed', v_sig;
    END IF;
    EXECUTE v_new;
  END LOOP;
END
$mig$;

COMMIT;
