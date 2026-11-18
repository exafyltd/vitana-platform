-- restore-sparring-grants.sql — applied LAST by restore-sparring-schema.sh (staging Aurora only).
-- 1. The vtid_ledger / global_vtid_seq statements of supabase/migrations/20260712110000_SECURITY_revoke_anon_grants_vtid_ledger_marketplace.sql
--    (its two marketplace statements are left out: public.merchants / public.products do not exist in this restore).
REVOKE ALL ON vtid_ledger FROM anon;
REVOKE ALL ON vtid_ledger FROM authenticated;
REVOKE USAGE, SELECT ON SEQUENCE global_vtid_seq FROM anon;
REVOKE USAGE, SELECT ON SEQUENCE global_vtid_seq FROM authenticated;
-- 2. PostgREST connects as `authenticator` and switches role per request (SET ROLE); it must be a member of the
--    three request roles (services/postgrest-aurora-proxy/README.md, "authenticator" section).
GRANT anon, authenticated, service_role TO authenticator;
-- 3. Allocation stays structurally disabled on isolated staging: no system_controls table is created, so
--    isVtidAllocatorEnabled() reads no row and answers false (services/gateway/src/services/system-controls-service.ts:418-430).
--    The staging sequence is moved far away from the official numbering, so a mis-configured allocation can never
--    mint a number that looks like an official VTID.
ALTER SEQUENCE global_vtid_seq RESTART WITH 90000;
-- 4. Tell PostgREST (listening on channel "pgrst") to reload its schema cache when this transaction commits.
NOTIFY pgrst, 'reload schema';
