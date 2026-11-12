-- VTID-05488 (mt-discover-r2/supplier-relationships-db) — pgTAP: supplier_tenant_relationships, products.distribution,
-- partner_tenant backfill, discover_tenant_gate_enabled() and the tenant-scoped products/merchants RLS (tasks D1-D6).
-- Runs on a throwaway Postgres after vtid_05488_fixture.sql and 20261102120000..20261102120300_vtid_05488_*.sql.
-- One transaction, rolled back at the end: never against a shared or live database.
--
-- Users: uMax ...c0 (Maxina), uA ...c1 (T_A), uB ...c2 (T_B), uN ...c3 (no membership: current_tenant_id() IS NULL).
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(79);

CREATE SCHEMA t05488;
GRANT USAGE ON SCHEMA t05488 TO authenticated, anon, service_role;

-- First column of the first row of p_sql, run as p_role with JWT sub = p_user (+ p_claims); 'error:<SQLSTATE>' on failure.
CREATE FUNCTION t05488.val(p_role text, p_user uuid, p_sql text, p_claims jsonb DEFAULT '{}'::jsonb)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims',
    (jsonb_build_object('role', p_role) || coalesce(jsonb_build_object('sub', p_user), '{}'::jsonb) || p_claims)::text, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN OTHERS THEN
    v := 'error:' || SQLSTATE;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v;
END $$;

-- Authenticated shorthand.
CREATE FUNCTION t05488.auth(p_user uuid, p_sql text, p_claims jsonb DEFAULT '{}'::jsonb)
RETURNS text LANGUAGE sql AS $$ SELECT t05488.val('authenticated', p_user, p_sql, p_claims) $$;

CREATE TEMP TABLE t05488_ids (k text PRIMARY KEY, v uuid NOT NULL);
INSERT INTO t05488_ids VALUES
  ('MAX', '05488000-0000-4000-8000-0000000000a0'), ('TA', '05488000-0000-4000-8000-0000000000a1'),
  ('TB', '05488000-0000-4000-8000-0000000000b1'),
  ('uMax', '05488000-0000-4000-8000-0000000000c0'), ('uA', '05488000-0000-4000-8000-0000000000c1'),
  ('uB', '05488000-0000-4000-8000-0000000000c2'), ('uN', '05488000-0000-4000-8000-0000000000c3'),
  ('MX1', '05488000-0000-4000-8000-0000000000d1'), ('MX2', '05488000-0000-4000-8000-0000000000d2'),
  ('MA', '05488000-0000-4000-8000-000000000a01'), ('MN', '05488000-0000-4000-8000-000000000a02');
GRANT SELECT ON t05488_ids TO PUBLIC;
CREATE FUNCTION t05488.id(p_k text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT v FROM pg_temp.t05488_ids WHERE k = p_k $$;

-- ---------------------------------------------------------------------------
-- 1. Objects (D1, D2, D4)
-- ---------------------------------------------------------------------------
SELECT has_table('public', 'supplier_tenant_relationships', 'supplier_tenant_relationships exists');
SELECT has_function('public', 'discover_tenant_gate_enabled', 'discover_tenant_gate_enabled() exists');
SELECT ok(coalesce((SELECT prosecdef AND provolatile = 's' FROM pg_proc WHERE oid = to_regprocedure('public.discover_tenant_gate_enabled()')), false),
  'discover_tenant_gate_enabled() is STABLE SECURITY DEFINER');
SELECT ok((SELECT proconfig::text FROM pg_proc WHERE oid = to_regprocedure('public.discover_tenant_gate_enabled()'))
          ~ 'search_path=public, pg_catalog', 'discover_tenant_gate_enabled() pins search_path = public, pg_catalog');
SELECT ok(coalesce(has_function_privilege('authenticated', to_regprocedure('public.discover_tenant_gate_enabled()'), 'EXECUTE')
      AND NOT has_function_privilege('anon', to_regprocedure('public.discover_tenant_gate_enabled()'), 'EXECUTE'), false),
  'authenticated may execute the helper, anon may not');
SELECT is((SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.supplier_tenant_relationships'::regclass AND attnum > 0
            AND NOT attisdropped AND attname IN ('id','merchant_id','partner_organization_id','tenant_id','status',
                                                 'vertical_key','created_at','updated_at','decided_at')), 9::bigint,
  'supplier_tenant_relationships has the nine designed columns');
SELECT is((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.supplier_tenant_relationships'::regclass), true,
  'RLS is enabled on supplier_tenant_relationships');
SELECT is((SELECT column_default || '/' || is_nullable FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'distribution'),
  '''community''::text/NO', 'products.distribution is NOT NULL DEFAULT community (the default stays)');
SELECT is((SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('products','merchants')
            AND (qual ~ 'is_member|tenant_id_for_policies' OR with_check ~ 'is_member|tenant_id_for_policies')), 0::bigint,
  'products/merchants policies reference neither is_member() nor tenant_id_for_policies()');
SELECT is((SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'supplier_tenant_relationships'
            AND (qual ~ 'is_member|tenant_id_for_policies')), 0::bigint,
  'supplier_tenant_relationships policies reference neither is_member() nor tenant_id_for_policies()');
SELECT ok((SELECT prosrc !~ 'is_member|tenant_id_for_policies' FROM pg_proc WHERE oid = to_regprocedure('public.discover_tenant_gate_enabled()')),
  'the helper body references neither is_member() nor tenant_id_for_policies()');
SELECT ok((SELECT qual ~ 'discover_tenant_gate_enabled' FROM pg_policies WHERE tablename = 'products' AND policyname = 'products_select')
      AND (SELECT qual ~ 'discover_tenant_gate_enabled' FROM pg_policies WHERE tablename = 'merchants' AND policyname = 'merchants_select'),
  'products_select and merchants_select are the gate-guarded policies');

-- ---------------------------------------------------------------------------
-- 2. products.distribution (D2)
-- ---------------------------------------------------------------------------
SELECT is((SELECT count(*) FROM public.products WHERE distribution <> 'community'), 0::bigint,
  'every product that existed before the migration is community');
SELECT throws_ok($$INSERT INTO public.products (merchant_id, source_network, source_product_id, title, affiliate_url, distribution)
  VALUES ('05488000-0000-4000-8000-0000000000d1', 'cj', 'bad', 'bad', 'https://example.test', 'bogus')$$,
  '23514', NULL, 'distribution CHECK rejects a value outside community|network');
SELECT lives_ok($$INSERT INTO public.products (merchant_id, source_network, source_product_id, title, affiliate_url, distribution)
  VALUES ('05488000-0000-4000-8000-0000000000d1', 'cj', 'pn', 'P_N0 network', 'https://example.test', 'network')$$,
  'distribution accepts network');
SELECT is((SELECT distribution FROM public.products WHERE source_product_id = 'p1'), 'community',
  'a writer that omits distribution gets community');
SELECT throws_ok($$UPDATE public.products SET distribution = NULL WHERE source_product_id = 'p1'$$, '23502', NULL,
  'distribution is NOT NULL');
DELETE FROM public.products WHERE source_product_id = 'pn';

-- ---------------------------------------------------------------------------
-- 3. Seed: existing merchants active for Maxina only (D1)
-- ---------------------------------------------------------------------------
SELECT is((SELECT count(*) FROM public.supplier_tenant_relationships WHERE tenant_id = t05488.id('MAX') AND status = 'active'),
  (SELECT count(*) FROM public.merchants WHERE id IN (t05488.id('MX1'), t05488.id('MX2'))),
  'every existing merchant is active for Maxina');
SELECT is((SELECT count(*) FROM public.supplier_tenant_relationships WHERE tenant_id <> t05488.id('MAX')), 0::bigint,
  'no other tenant is seeded');
SELECT ok((SELECT bool_and(decided_at IS NOT NULL) FROM public.supplier_tenant_relationships), 'seeded rows carry decided_at');

-- ---------------------------------------------------------------------------
-- 4. supplier_tenant_relationships constraints and RLS (D1, D6)
-- ---------------------------------------------------------------------------
SELECT throws_ok($$INSERT INTO public.supplier_tenant_relationships (merchant_id, tenant_id, status)
  VALUES ('05488000-0000-4000-8000-0000000000d1', '05488000-0000-4000-8000-0000000000a1', 'bogus')$$,
  '23514', NULL, 'status CHECK rejects a value outside proposed|active|declined|suspended');
SELECT lives_ok($$INSERT INTO public.supplier_tenant_relationships (merchant_id, tenant_id, status)
  VALUES ('05488000-0000-4000-8000-0000000000d1', '05488000-0000-4000-8000-0000000000a1', 'proposed')$$,
  'a proposed relationship is accepted');
SELECT throws_ok($$INSERT INTO public.supplier_tenant_relationships (merchant_id, tenant_id, status)
  VALUES ('05488000-0000-4000-8000-0000000000d1', '05488000-0000-4000-8000-0000000000a1', 'active')$$,
  '23505', NULL, 'one relationship per supplier, tenant and vertical');
SELECT throws_ok($$INSERT INTO public.supplier_tenant_relationships (merchant_id, tenant_id)
  VALUES ('05488000-0000-4000-8000-0000000000d1', '05488000-0000-4000-8000-0000000000ee')$$,
  '23503', NULL, 'tenant_id must reference a tenant');

-- Fixture rows: M_A (supplier, active for T_A only, community product P_A), M_N (no relationship, network product P_N),
-- a declined row for T_B on M_A, and a proposed T_A row on M_N.
INSERT INTO public.merchants (id, name, source_network, is_active) VALUES
  (t05488.id('MA'), 'M_A supplier only for T_A', 'partner', true), (t05488.id('MN'), 'M_N network supplier', 'partner', true);
INSERT INTO public.products (merchant_id, source_network, source_product_id, title, affiliate_url, distribution) VALUES
  (t05488.id('MA'), 'partner', 'pa', 'P_A community T_A only', 'https://example.test/a', 'community'),
  (t05488.id('MN'), 'partner', 'pn', 'P_N network', 'https://example.test/n', 'network');
DELETE FROM public.supplier_tenant_relationships WHERE merchant_id = t05488.id('MX1') AND tenant_id = t05488.id('TA');
INSERT INTO public.supplier_tenant_relationships (merchant_id, tenant_id, status, decided_at) VALUES
  (t05488.id('MA'), t05488.id('TA'), 'active', now()),
  (t05488.id('MA'), t05488.id('TB'), 'declined', now()),
  (t05488.id('MN'), t05488.id('TA'), 'proposed', NULL);

SELECT is(t05488.auth(t05488.id('uA'), 'SELECT count(*) FROM public.supplier_tenant_relationships WHERE tenant_id = ''05488000-0000-4000-8000-0000000000a1'''),
  '2', 'T_A member reads the 2 T_A rows');
SELECT is(t05488.auth(t05488.id('uB'), 'SELECT count(*) FROM public.supplier_tenant_relationships WHERE tenant_id = ''05488000-0000-4000-8000-0000000000a1'''),
  '0', 'T_B member reads 0 T_A rows (R1-F2)');
SELECT is(t05488.auth(t05488.id('uB'), 'SELECT count(*) FROM public.supplier_tenant_relationships'),
  '1', 'T_B member reads only its own tenant''s row (the declined one)');
SELECT is(t05488.auth(t05488.id('uMax'), 'SELECT count(*) FROM public.supplier_tenant_relationships'),
  '2', 'Maxina member reads exactly the Maxina seed rows');
SELECT is(t05488.auth(t05488.id('uN'), 'SELECT count(*) FROM public.supplier_tenant_relationships'),
  '0', 'a user without membership reads 0 rows');
SELECT is(t05488.auth(NULL, 'SELECT count(*) FROM public.supplier_tenant_relationships'),
  '0', 'a session without auth.uid() reads 0 rows');
SELECT is(t05488.auth(t05488.id('uA'), 'INSERT INTO public.supplier_tenant_relationships (merchant_id, tenant_id) VALUES (''05488000-0000-4000-8000-000000000a02'', ''05488000-0000-4000-8000-0000000000a1'')'),
  'error:42501', 'a member cannot write (no INSERT privilege)');
SELECT is(t05488.auth(t05488.id('uA'), 'UPDATE public.supplier_tenant_relationships SET status = ''active'' WHERE tenant_id = ''05488000-0000-4000-8000-0000000000a1'''),
  'error:42501', 'a member cannot update');
SELECT is(t05488.val('anon', NULL, 'SELECT count(*) FROM public.supplier_tenant_relationships'),
  'error:42501', 'anon has no access');
SELECT is(t05488.val('service_role', NULL, 'SELECT count(*) FROM public.supplier_tenant_relationships'),
  '5', 'service_role reads every row');
SELECT is(t05488.val('service_role', NULL, 'WITH i AS (INSERT INTO public.supplier_tenant_relationships (merchant_id, tenant_id, status) VALUES (''05488000-0000-4000-8000-000000000a02'', ''05488000-0000-4000-8000-0000000000b1'', ''proposed'') RETURNING 1) SELECT count(*) FROM i'),
  '1', 'service_role can write');
DELETE FROM public.supplier_tenant_relationships WHERE merchant_id = t05488.id('MN') AND tenant_id = t05488.id('TB');

-- ---------------------------------------------------------------------------
-- 5. partner_tenant backfill (D3)
-- ---------------------------------------------------------------------------
SELECT is((SELECT count(*) FROM public.bak_vtid_05488_partner_tenant), 6::bigint, 'the snapshot holds the 6 original partner_tenant rows');
SELECT is((SELECT tenant_uuid FROM public.partner_tenant WHERE id = 'pt1'), t05488.id('MAX'), 'a uuid text of one tenant maps');
SELECT is((SELECT tenant_uuid FROM public.partner_tenant WHERE id = 'pt2'), t05488.id('MAX'), 'a slug text (case, spaces) of one tenant maps');
SELECT is((SELECT tenant_uuid FROM public.partner_tenant WHERE id = 'pt5'), t05488.id('TA'), 'the slug of T_A maps to T_A');
SELECT is((SELECT tenant_uuid FROM public.partner_tenant WHERE id = 'pt3'), NULL::uuid, 'an unknown key stays NULL');
SELECT is((SELECT tenant_uuid FROM public.partner_tenant WHERE id = 'pt4'), NULL::uuid, 'a uuid naming no tenant stays NULL');
SELECT is((SELECT tenant_uuid FROM public.partner_tenant WHERE id = 'pt6'), NULL::uuid, 'a text that names two tenants (uuid of one, slug of another) stays NULL');
SELECT is((SELECT count(*) FROM public.partner_tenant p JOIN public.bak_vtid_05488_partner_tenant b ON b.id = p.id
            WHERE p.tenant_id IS DISTINCT FROM b.tenant_id), 0::bigint, 'the free-text tenant_id column is untouched (expand only)');
SELECT is((SELECT count(*) FROM information_schema.columns WHERE table_name = 'partner_tenant' AND column_name = 'tenant_id' AND data_type = 'text'),
  1::bigint, 'partner_tenant.tenant_id is still text for the Prisma writers');
SELECT is(has_table_privilege('authenticated', 'public.bak_vtid_05488_partner_tenant', 'SELECT'), false,
  'the snapshot table is not readable by client roles');

-- ---------------------------------------------------------------------------
-- 6. Gate off everywhere (no tenant_settings row): identical to the is_active-only read (D4)
-- ---------------------------------------------------------------------------
-- Active products now: P_X1, P_A, P_N. Active merchants: MX1, MA, MN.
SELECT is(t05488.auth(t05488.id('uA'), 'SELECT public.discover_tenant_gate_enabled()'), 'false', 'no gate anywhere: helper false (T_A)');
SELECT is(t05488.auth(t05488.id('uN'), 'SELECT public.discover_tenant_gate_enabled()'), 'false', 'no gate anywhere: helper false for a NULL tenant');
SELECT is(t05488.auth(t05488.id('uA'), 'SELECT count(*) FROM public.products'),
  (SELECT count(*)::text FROM public.products WHERE is_active), 'gate off: T_A sees exactly the is_active products');
SELECT is(t05488.auth(t05488.id('uB'), 'SELECT count(*) FROM public.products'),
  (SELECT count(*)::text FROM public.products WHERE is_active), 'gate off: T_B sees exactly the is_active products');
SELECT is(t05488.auth(t05488.id('uN'), 'SELECT count(*) FROM public.products'),
  (SELECT count(*)::text FROM public.products WHERE is_active), 'gate off: NULL tenant sees exactly the is_active products');
SELECT is(t05488.auth(t05488.id('uMax'), 'SELECT count(*) FROM public.merchants'),
  (SELECT count(*)::text FROM public.merchants WHERE is_active), 'gate off: Maxina sees exactly the is_active merchants');
SELECT is(t05488.auth(t05488.id('uN'), 'SELECT count(*) FROM public.merchants'),
  (SELECT count(*)::text FROM public.merchants WHERE is_active), 'gate off: NULL tenant sees exactly the is_active merchants');

-- ---------------------------------------------------------------------------
-- 7. Gate on for T_A only
-- ---------------------------------------------------------------------------
INSERT INTO public.tenant_settings (tenant_id, feature_flags) VALUES
  (t05488.id('TA'), '{"mt":{"discover_tenant_gate":true}}');
SELECT is(t05488.auth(t05488.id('uA'), 'SELECT public.discover_tenant_gate_enabled()'), 'true', 'T_A gate on: helper true for T_A');
SELECT is(t05488.auth(t05488.id('uB'), 'SELECT public.discover_tenant_gate_enabled()'), 'false',
  'T_B has no tenant_settings row: helper false for a non-NULL tenant');
SELECT is(t05488.auth(t05488.id('uMax'), 'SELECT public.discover_tenant_gate_enabled()'), 'false', 'Maxina has no row: helper false');
SELECT is(t05488.auth(t05488.id('uN'), 'SELECT public.discover_tenant_gate_enabled()'), 'true',
  'NULL tenant and any gate on: helper true (round-2 R1-F1)');
SELECT is(t05488.auth(t05488.id('uA'), 'SELECT string_agg(title, '','' ORDER BY title) FROM public.products'),
  'P_A community T_A only,P_N network', 'T_A: its own supplier and the network product, not Maxina''s community product');
SELECT is(t05488.auth(t05488.id('uN'), 'SELECT string_agg(title, '','' ORDER BY title) FROM public.products'),
  'P_N network', 'NULL tenant with a gate on somewhere: network rows only, no error');
SELECT is(t05488.auth(t05488.id('uB'), 'SELECT count(*) FROM public.products'),
  (SELECT count(*)::text FROM public.products WHERE is_active), 'T_B gate off: still the is_active-only result');
SELECT is(t05488.auth(t05488.id('uA'), 'SELECT string_agg(name, '','' ORDER BY name) FROM public.merchants'),
  'M_A supplier only for T_A,M_N network supplier', 'T_A merchants: own supplier and the network supplier');
SELECT is(t05488.auth(t05488.id('uN'), 'SELECT string_agg(name, '','' ORDER BY name) FROM public.merchants'),
  'M_N network supplier', 'NULL tenant merchants: the network supplier only');
SELECT is(t05488.auth(t05488.id('uN'), 'SELECT public.discover_tenant_gate_enabled()', '{"tenant_id":"05488000-0000-4000-8000-0000000000b1"}'),
  'false', 'a JWT that names T_B (no row) resolves a non-NULL tenant: false, not the any-gate branch');

-- ---------------------------------------------------------------------------
-- 8. Gate on for T_B too, then Maxina: T_B sees 0 T_A-only supplier rows, a network product is visible to both
-- ---------------------------------------------------------------------------
INSERT INTO public.tenant_settings (tenant_id, feature_flags) VALUES (t05488.id('TB'), '{"mt":{"discover_tenant_gate":true}}');
SELECT is(t05488.auth(t05488.id('uB'), 'SELECT count(*) FROM public.products WHERE title LIKE ''P_A%'''), '0',
  'gate on for T_B: 0 T_A-only products (R1-F2)');
SELECT is(t05488.auth(t05488.id('uB'), 'SELECT count(*) FROM public.merchants WHERE name LIKE ''M_A%'''), '0',
  'gate on for T_B: 0 T_A-only merchants (R1-F2; the declined relationship grants nothing)');
SELECT is(t05488.auth(t05488.id('uB'), 'SELECT count(*) FROM public.products WHERE title LIKE ''P_N%'''), '1',
  'gate on for T_B: the network product is visible');
SELECT is(t05488.auth(t05488.id('uA'), 'SELECT count(*) FROM public.products WHERE title LIKE ''P_N%'''), '1',
  'the same network product is visible to T_A');
INSERT INTO public.tenant_settings (tenant_id, feature_flags) VALUES (t05488.id('MAX'), '{"mt":{"discover_tenant_gate":true}}');
SELECT is(t05488.auth(t05488.id('uMax'), 'SELECT string_agg(title, '','' ORDER BY title) FROM public.products'),
  'P_N network,P_X1 existing active', 'gate on for Maxina: its seeded supplier and the network product, not T_A''s');
SELECT is(t05488.auth(t05488.id('uMax'), 'SELECT string_agg(name, '','' ORDER BY name) FROM public.merchants'),
  'Existing merchant one,M_N network supplier', 'gate on for Maxina: the seeded active merchant and the network supplier');

-- A suspended relationship stops granting visibility.
UPDATE public.supplier_tenant_relationships SET status = 'suspended' WHERE merchant_id = t05488.id('MA') AND tenant_id = t05488.id('TA');
SELECT is(t05488.auth(t05488.id('uA'), 'SELECT count(*) FROM public.products WHERE title LIKE ''P_A%'''), '0',
  'a suspended relationship hides the supplier from its tenant');
UPDATE public.supplier_tenant_relationships SET status = 'active' WHERE merchant_id = t05488.id('MA') AND tenant_id = t05488.id('TA');
SELECT is(t05488.auth(t05488.id('uA'), 'SELECT count(*) FROM public.products WHERE title LIKE ''P_A%'''), '1', 'active again: visible again');
-- is_active still filters in every mode.
UPDATE public.products SET is_active = false WHERE title LIKE 'P_N%';
SELECT is(t05488.auth(t05488.id('uA'), 'SELECT count(*) FROM public.products WHERE title LIKE ''P_N%'''), '0', 'an inactive network product is hidden');
SELECT is(t05488.auth(t05488.id('uA'), 'SELECT count(*) FROM public.merchants WHERE name LIKE ''M_N%'''), '0',
  'a merchant whose only network product is inactive is not reached through the network term');
UPDATE public.products SET is_active = true WHERE title LIKE 'P_N%';

-- ---------------------------------------------------------------------------
-- 9. Flag edge cases: absent, false, junk; then every gate off with a NULL tenant
-- ---------------------------------------------------------------------------
UPDATE public.tenant_settings SET feature_flags = '{"mt":{"discover_tenant_gate":false}}' WHERE tenant_id = t05488.id('TA');
UPDATE public.tenant_settings SET feature_flags = '{}' WHERE tenant_id = t05488.id('TB');
UPDATE public.tenant_settings SET feature_flags = '{"mt":{"discover_tenant_gate":"not-a-boolean"}}' WHERE tenant_id = t05488.id('MAX');
SELECT is(t05488.auth(t05488.id('uA'), 'SELECT public.discover_tenant_gate_enabled()'), 'false', 'flag false: helper false');
SELECT is(t05488.auth(t05488.id('uB'), 'SELECT public.discover_tenant_gate_enabled()'), 'false', 'row without the flag: helper false');
SELECT is(t05488.auth(t05488.id('uMax'), 'SELECT public.discover_tenant_gate_enabled()'), 'false', 'junk flag value: helper false, no error');
SELECT is(t05488.auth(t05488.id('uN'), 'SELECT public.discover_tenant_gate_enabled()'), 'false',
  'every gate off + NULL tenant: helper false');
SELECT is(t05488.auth(t05488.id('uN'), 'SELECT count(*) FROM public.products'),
  (SELECT count(*)::text FROM public.products WHERE is_active), 'every gate off + NULL tenant: the is_active-only result');
SELECT is(t05488.auth(t05488.id('uN'), 'SELECT count(*) FROM public.merchants'),
  (SELECT count(*)::text FROM public.merchants WHERE is_active), 'every gate off + NULL tenant: the is_active-only merchants');
SELECT is(t05488.val('service_role', NULL, 'SELECT count(*) FROM public.products'), (SELECT count(*)::text FROM public.products),
  'service_role is untouched by the policy (sees inactive rows too)');

SELECT * FROM finish();
ROLLBACK;
