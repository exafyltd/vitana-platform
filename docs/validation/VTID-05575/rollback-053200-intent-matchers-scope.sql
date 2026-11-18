-- VTID-05575 rollback of 20261102053200: put the old pool predicate and the 'public' default back in the four matchers.
-- Run FIRST (before rollback-053100 and rollback-053000). Same method as the migration: each live function is read with
-- pg_get_functiondef(), the three replaced fragments are turned back as text, and the result is CREATE OR REPLACEd.
-- Safe to re-run (a function without intent_pool_allows is skipped). Changes no data. Run after the owner approves (collaboration.md 7d).
BEGIN;
SET LOCAL lock_timeout = '3s';
DO $rb$
DECLARE
  v_sig text; v_oid oid; v_old text; v_new text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.search_intent_catalog(uuid,uuid,text,text,jsonb,text,text,integer)',
    'public.search_intent_catalog_v2(uuid,uuid,text,text,jsonb,text,text,integer)',
    'public.compute_intent_matches(uuid,integer)',
    'public.compute_intent_matches_v2(uuid,integer)'
  ] LOOP
    v_oid := to_regprocedure(v_sig);
    IF v_oid IS NULL THEN CONTINUE; END IF;
    v_old := pg_get_functiondef(v_oid);
    IF position('intent_pool_allows' IN v_old) = 0 THEN CONTINUE; END IF;
    v_new := replace(v_old, 'public.intent_pool_allows(ui.tenant_id, p_tenant_id, ui.requester_user_id, p_visibility)',
                     '(ui.tenant_id = p_tenant_id OR p_visibility = ''public'')');
    v_new := replace(v_new, 'public.intent_pool_allows(ui.tenant_id, src.tenant_id, ui.requester_user_id, CASE WHEN src.visibility = ''public'' THEN ''network'' ELSE ''community'' END)',
                     '(ui.tenant_id = src.tenant_id OR src.visibility = ''public'')');
    v_new := replace(v_new, 'p_visibility text DEFAULT ''community''::text', 'p_visibility text DEFAULT ''public''::text');
    IF position('intent_pool_allows' IN v_new) > 0 THEN
      RAISE EXCEPTION 'VTID-05575 rollback: % still references intent_pool_allows after the reverse rewrite', v_sig;
    END IF;
    EXECUTE v_new;
  END LOOP;
END
$rb$;
DROP FUNCTION IF EXISTS public.intent_pool_allows(uuid, uuid, uuid, text);
COMMIT;
