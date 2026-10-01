-- VTID-04716: hardening after the Supabase security advisor ran on the five
-- feature data layers (20260928200000..200400).
--  * Supabase grants EXECUTE on new public functions to anon by default. Every
--    function below refuses without auth.uid(), but none has a reason to be
--    reachable anonymously, so anon (and PUBLIC) lose EXECUTE. Members
--    (authenticated) keep it: the routes call these with the member's JWT and
--    each one is scoped to auth.uid().
--  * is_in_quiet_hours gets a fixed search_path.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure AS sig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN (
            'caller_tenant_id', 'caller_is_tenant_member', 'is_in_quiet_hours',
            'overload_compute_baselines', 'overload_get_baselines', 'overload_detect',
            'overload_get_detections', 'overload_dismiss', 'overload_record_pattern', 'overload_explain',
            'taste_profile_get', 'taste_profile_set', 'lifestyle_profile_get', 'lifestyle_profile_set',
            'taste_alignment_bundle_get', 'taste_reaction_record', 'taste_alignment_audit_get',
            'preference_set', 'preference_delete', 'constraint_set', 'constraint_delete',
            'preference_bundle_get', 'preference_confirm', 'inference_reinforce',
            'inference_downgrade', 'preference_get_audit'
          )
    LOOP
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.sig);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
    END LOOP;
END $$;

ALTER FUNCTION public.is_in_quiet_hours(JSONB, TIME) SET search_path = public;
