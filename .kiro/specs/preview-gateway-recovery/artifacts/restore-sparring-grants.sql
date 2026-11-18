-- restore-sparring-grants.sql — applied LAST by restore-sparring-schema.sh (staging Aurora only).
-- 1. The vtid_ledger / global_vtid_seq statements of supabase/migrations/20260712110000_SECURITY_revoke_anon_grants_vtid_ledger_marketplace.sql
--    (its two marketplace statements are left out: public.merchants / public.products are not part of this restore).
--    Needed because 20251217000000 grants ALL on vtid_ledger to anon and authenticated.
REVOKE ALL ON vtid_ledger FROM anon;
REVOKE ALL ON vtid_ledger FROM authenticated;
REVOKE USAGE, SELECT ON SEQUENCE global_vtid_seq FROM anon;
REVOKE USAGE, SELECT ON SEQUENCE global_vtid_seq FROM authenticated;
-- 2. PostgREST connects as `authenticator` and switches role per request (SET ROLE); it must be a member of the
--    request roles (services/postgrest-aurora-proxy/README.md, "authenticator" section). Granted only where missing:
--    on Aurora staging the memberships already exist (live dry run 2026-11-18), and re-granting would need ADMIN OPTION.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
                    WHERE g.rolname = r AND u.rolname = 'authenticator') THEN
      EXECUTE format('GRANT %I TO authenticator', r);
    END IF;
  END LOOP;
END $$;
-- 3. Tell PostgREST (listening on channel "pgrst") to reload its schema cache.
NOTIFY pgrst, 'reload schema';
