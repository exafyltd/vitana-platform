-- VTID-05464 (mt-identity-r2 / access-token-hook-shadow) pgTAP plan.
--
-- Runs with pg_prove on a THROWAWAY local cluster only, after
-- supabase/tests/mt_identity_hook_fixture.sql and both forward migrations
-- (order: docs/validation/VTID-05464/commands.log). Everything runs in one
-- transaction and is rolled back. Never point it at a shared database.
--
-- Covers the lane's acceptance (tasks.md group access-token-hook-shadow):
--  * the hook returns the original claims on a forced error;
--  * it never emits a top-level tenant_id, and tenant_id_shadow is the only
--    claim it adds;
--  * the mismatch log fills on a deliberate disagreement (and de-duplicates);
--  * authenticated (and anon) cannot read the log; service_role can;
--  * EXECUTE on the hook only for supabase_auth_admin.

BEGIN;
SELECT plan(36);

-- Event shaped like Supabase Auth's custom_access_token payload.
CREATE FUNCTION pg_temp.ev(p_user text, p_pref text DEFAULT NULL) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'user_id', p_user,
    'authentication_method', 'password',
    'claims', jsonb_build_object(
      'aud', 'authenticated', 'role', 'authenticated', 'sub', p_user,
      'app_metadata', CASE WHEN p_pref IS NULL THEN jsonb_build_object('provider', 'email')
                           ELSE jsonb_build_object('provider', 'email', 'active_tenant_id', p_pref) END,
      'user_metadata', '{}'::jsonb))
$$;

CREATE FUNCTION pg_temp.hook(e jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.custom_access_token_hook_shadow(e)
$$;

-- ── Shape and grants ─────────────────────────────────────────────────────
SELECT has_function('public', 'custom_access_token_hook_shadow', ARRAY['jsonb'], 'hook function exists');
SELECT function_returns('public', 'custom_access_token_hook_shadow', ARRAY['jsonb'], 'jsonb', 'hook returns jsonb');
SELECT ok((SELECT prosecdef FROM pg_proc WHERE oid = 'public.custom_access_token_hook_shadow(jsonb)'::regprocedure),
          'hook is SECURITY DEFINER');
SELECT ok((SELECT proconfig @> ARRAY['search_path=""', 'lock_timeout=100ms', 'statement_timeout=500ms']
             FROM pg_proc WHERE oid = 'public.custom_access_token_hook_shadow(jsonb)'::regprocedure),
          'hook pins search_path, lock_timeout and statement_timeout');
SELECT ok(NOT has_function_privilege('anon', 'public.custom_access_token_hook_shadow(jsonb)', 'EXECUTE'),
          'anon cannot execute the hook');
SELECT ok(NOT has_function_privilege('authenticated', 'public.custom_access_token_hook_shadow(jsonb)', 'EXECUTE'),
          'authenticated cannot execute the hook');
SELECT ok(NOT has_function_privilege('service_role', 'public.custom_access_token_hook_shadow(jsonb)', 'EXECUTE'),
          'service_role cannot execute the hook');
SELECT ok(has_function_privilege('supabase_auth_admin', 'public.custom_access_token_hook_shadow(jsonb)', 'EXECUTE'),
          'supabase_auth_admin can execute the hook');
SELECT ok(has_schema_privilege('supabase_auth_admin', 'public', 'USAGE'),
          'supabase_auth_admin has USAGE on schema public');

-- ── Fail open: forced errors return the original event ───────────────────
ALTER TABLE public.user_tenants RENAME TO user_tenants_hidden_vtid_05464;
SELECT is(pg_temp.hook(pg_temp.ev('00000000-0000-0000-0000-000000000011')),
          pg_temp.ev('00000000-0000-0000-0000-000000000011'),
          'forced error (user_tenants missing): original event returned unchanged');
ALTER TABLE public.user_tenants_hidden_vtid_05464 RENAME TO user_tenants;

SELECT is(pg_temp.hook(pg_temp.ev('not-a-uuid')), pg_temp.ev('not-a-uuid'),
          'forced error (user_id not a uuid): original event returned unchanged');
SELECT is(pg_temp.hook('{"user_id":"00000000-0000-0000-0000-000000000011","claims":"x"}'::jsonb),
          '{"user_id":"00000000-0000-0000-0000-000000000011","claims":"x"}'::jsonb,
          'forced error (claims not an object): original event returned unchanged');
SELECT is(pg_temp.hook(pg_temp.ev('00000000-0000-0000-0000-000000000011', 'garbage')),
          pg_temp.ev('00000000-0000-0000-0000-000000000011', 'garbage'),
          'forced error (active_tenant_id not a uuid): original event returned unchanged');
SELECT is(pg_temp.hook(NULL), NULL, 'NULL event: returned as is');

-- ── Shadow claim only ────────────────────────────────────────────────────
SELECT is(pg_temp.hook(pg_temp.ev('00000000-0000-0000-0000-000000000011')) -> 'claims' ->> 'tenant_id_shadow',
          'aaaaaaaa-0000-0000-0000-0000000000a1',
          'no preference: shadow is the primary membership');
SELECT ok(NOT (pg_temp.hook(pg_temp.ev('00000000-0000-0000-0000-000000000011')) -> 'claims' ? 'tenant_id'),
          'no top-level tenant_id claim is emitted');
SELECT is(pg_temp.hook(pg_temp.ev('00000000-0000-0000-0000-000000000011')) #- '{claims,tenant_id_shadow}',
          pg_temp.ev('00000000-0000-0000-0000-000000000011'),
          'tenant_id_shadow is the only change to the event');
SELECT is(pg_temp.hook(pg_temp.ev('00000000-0000-0000-0000-000000000011', 'bbbbbbbb-0000-0000-0000-0000000000b2'))
            -> 'claims' ->> 'tenant_id_shadow',
          'bbbbbbbb-0000-0000-0000-0000000000b2',
          'preference for a tenant the user is a member of is honoured');
SELECT is((SELECT count(*)::int FROM public.tenant_claim_mismatch_log), 0,
          'agreeing calls write no mismatch row');

-- ── Deliberate disagreement fills the log ────────────────────────────────
SELECT is(pg_temp.hook(pg_temp.ev('00000000-0000-0000-0000-000000000011', 'cccccccc-0000-0000-0000-0000000000c3'))
            -> 'claims' ->> 'tenant_id_shadow',
          'aaaaaaaa-0000-0000-0000-0000000000a1',
          'preference for a non-member tenant is ignored: shadow is the primary membership');
SELECT ok(NOT (pg_temp.hook(pg_temp.ev('00000000-0000-0000-0000-000000000011', 'cccccccc-0000-0000-0000-0000000000c3'))
                 -> 'claims' ? 'tenant_id'),
          'disagreement: still no top-level tenant_id');
SELECT results_eq(
  $$SELECT decision, claimed_tenant_id::text, shadow_tenant_id::text, seen_count, authentication_method
      FROM public.tenant_claim_mismatch_log WHERE user_id = '00000000-0000-0000-0000-000000000011'$$,
  $$VALUES ('preference_not_member'::text, 'cccccccc-0000-0000-0000-0000000000c3'::text,
            'aaaaaaaa-0000-0000-0000-0000000000a1'::text, 2, 'password'::text)$$,
  'mismatch log: one preference_not_member row, repeat counted (seen_count 2)');

SELECT is(pg_temp.hook(pg_temp.ev('00000000-0000-0000-0000-000000000022')) -> 'claims' ->> 'tenant_id_shadow',
          'bbbbbbbb-0000-0000-0000-0000000000b2',
          'no is_primary row: shadow is the oldest membership');
SELECT is((SELECT decision FROM public.tenant_claim_mismatch_log WHERE user_id = '00000000-0000-0000-0000-000000000022'),
          'primary_missing', 'mismatch log: primary_missing row');

SELECT is(pg_temp.hook(pg_temp.ev('00000000-0000-0000-0000-000000000033', 'aaaaaaaa-0000-0000-0000-0000000000a1')),
          pg_temp.ev('00000000-0000-0000-0000-000000000033', 'aaaaaaaa-0000-0000-0000-0000000000a1'),
          'no membership: event unchanged (no shadow claim)');
SELECT results_eq(
  $$SELECT decision, claimed_tenant_id::text, shadow_tenant_id::text
      FROM public.tenant_claim_mismatch_log WHERE user_id = '00000000-0000-0000-0000-000000000033'$$,
  $$VALUES ('no_membership'::text, 'aaaaaaaa-0000-0000-0000-0000000000a1'::text, NULL::text)$$,
  'mismatch log: no_membership row with the claimed tenant');

-- A failing log write never changes the token.
ALTER TABLE public.tenant_claim_mismatch_log RENAME TO tenant_claim_mismatch_log_hidden_vtid_05464;
SELECT is(pg_temp.hook(pg_temp.ev('00000000-0000-0000-0000-000000000011', 'cccccccc-0000-0000-0000-0000000000c3'))
            -> 'claims' ->> 'tenant_id_shadow',
          'aaaaaaaa-0000-0000-0000-0000000000a1',
          'log unavailable: the hook still returns the shadow claim');
ALTER TABLE public.tenant_claim_mismatch_log_hidden_vtid_05464 RENAME TO tenant_claim_mismatch_log;

SELECT throws_ok(
  $$INSERT INTO public.tenant_claim_mismatch_log (user_id, decision) VALUES (gen_random_uuid(), 'bogus')$$,
  '23514', NULL, 'mismatch log refuses an unknown decision');

-- ── Who can call the hook ────────────────────────────────────────────────
SET LOCAL ROLE supabase_auth_admin;
SELECT is(public.custom_access_token_hook_shadow(
            '{"user_id":"00000000-0000-0000-0000-000000000011","claims":{"sub":"00000000-0000-0000-0000-000000000011","role":"authenticated"}}'::jsonb)
            -> 'claims' ->> 'tenant_id_shadow',
          'aaaaaaaa-0000-0000-0000-0000000000a1',
          'supabase_auth_admin (the Auth server) gets the shadow claim');
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$SELECT public.custom_access_token_hook_shadow('{"user_id":"00000000-0000-0000-0000-000000000011","claims":{}}'::jsonb)$$,
  '42501', NULL, 'authenticated cannot call the hook');
RESET ROLE;

-- ── The log is service-role-only ─────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT count(*) FROM public.tenant_claim_mismatch_log$$,
                 '42501', NULL, 'authenticated cannot read the mismatch log');
SELECT throws_ok(
  $$INSERT INTO public.tenant_claim_mismatch_log (user_id, decision) VALUES (gen_random_uuid(), 'no_membership')$$,
  '42501', NULL, 'authenticated cannot write the mismatch log');
RESET ROLE;

SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT count(*) FROM public.tenant_claim_mismatch_log$$,
                 '42501', NULL, 'anon cannot read the mismatch log');
RESET ROLE;

SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::int FROM public.tenant_claim_mismatch_log), 3,
          'service_role reads the mismatch log (3 rows)');
RESET ROLE;

SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tenant_claim_mismatch_log'::regclass),
          'RLS is enabled on the mismatch log');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tenant_claim_mismatch_log'),
          0, 'the mismatch log carries no policy');

SELECT * FROM finish();
ROLLBACK;
