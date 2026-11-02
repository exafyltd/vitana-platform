-- mt-guardrails-r2 / local-test-stack: pgTAP smoke test, run by smoke.sh via
-- pg_prove against the disposable local stack after replay + seed.
BEGIN;
SET LOCAL search_path = public, extensions;

SELECT plan(8);

SELECT has_extension('pgtap', 'pgtap extension is installed');

SELECT ok(to_regclass('auth.users') IS NOT NULL, 'auth.users pre-exists (supabase/postgres image)');

SELECT is(
  (SELECT count(*)::int FROM public.tenants
    WHERE id IN ('0a000000-0000-4000-8000-00000000000a', '0b000000-0000-4000-8000-00000000000b')),
  2, 'fixture tenants T_A and T_B are loaded');

SELECT is(
  (SELECT count(*)::int FROM auth.users
    WHERE id IN ('0a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-0000000000a2',
                 '0b000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-0000000000b2',
                 '0ab00000-0000-4000-8000-000000000ab1')),
  5, 'fixture users are in auth.users');

SELECT is(
  (SELECT count(*)::int FROM public.user_tenants
    WHERE (tenant_id, user_id) IN (
      ('0a000000-0000-4000-8000-00000000000a'::uuid, '0a000000-0000-4000-8000-0000000000a1'::uuid),
      ('0a000000-0000-4000-8000-00000000000a'::uuid, '0a000000-0000-4000-8000-0000000000a2'::uuid),
      ('0b000000-0000-4000-8000-00000000000b'::uuid, '0b000000-0000-4000-8000-0000000000b1'::uuid),
      ('0b000000-0000-4000-8000-00000000000b'::uuid, '0b000000-0000-4000-8000-0000000000b2'::uuid),
      ('0a000000-0000-4000-8000-00000000000a'::uuid, '0ab00000-0000-4000-8000-000000000ab1'::uuid),
      ('0b000000-0000-4000-8000-00000000000b'::uuid, '0ab00000-0000-4000-8000-000000000ab1'::uuid))),
  6, 'fixture memberships are in user_tenants');

SELECT ok(
  EXISTS (SELECT 1 FROM public.tenants
           WHERE id = '0a000000-0000-4000-8000-00000000000a'
             AND name LIKE '%CANARY_A_0a000000-0000-4000-8000-00000000ca01%'),
  'CANARY_A marker is present on T_A');

SELECT ok(
  NOT EXISTS (SELECT 1 FROM public.tenants
               WHERE id = '0b000000-0000-4000-8000-00000000000b' AND name LIKE '%CANARY_A_%'),
  'T_B carries no CANARY_A marker');

-- community_groups is a required table (required-tables.txt), so the fixture's
-- guarded canary row must exist.
SELECT ok(
  EXISTS (SELECT 1 FROM public.community_groups
           WHERE id = '0a000000-0000-4000-8000-00000000c601'
             AND tenant_id = '0a000000-0000-4000-8000-00000000000a'
             AND name LIKE 'CANARY_A_%'),
  'CANARY_A row is present in community_groups for T_A');

SELECT * FROM finish();
ROLLBACK;
