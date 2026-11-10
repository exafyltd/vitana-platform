-- VTID-05446 (mt-guardrails-r2/isolation-suite): tenant isolation suite, pgTAP style, run on the PGlite local stack
-- through the pgTAP-compatible shim (scripts/mt/stack/tap-shim.sql). Real pgTAP is NOT used (plan.md Amendment 2, decision 7).
-- Run it with scripts/ci/sql-tests/run-mt-isolation-test.sh. The runner prepends three settings:
--   mt.health_tables    comma list from scripts/mt/inventory/health-tables.json (the shared health-table list, never copied here)
--   mt.required_tables  comma list from supabase/tests/local-stack/required-tables.txt
--   mt.strict           '1' (default, also when unset): a table or claim the stack cannot verify FAILS the suite; '0' (the runner's
--                       --report mode): it is reported "UNVERIFIED" and counted as neither passed nor failed (plan.md Amendment 3,
--                       decision 3: never reported as passing)
--
-- WHAT A GREEN RUN MEANS: on the tables that were replayed, b_member does not see T_A / CANARY_A rows and cannot write a T_A
-- row, under the tenant resolution and policies that were REPLAYED. 44 migrations that redefine tenant resolution or policies on
-- present tables are skipped on this stack (docs/multitenancy/LOCAL-STACK.md "Isolation gap on the present tables"), so every
-- claim below is NON-PRODUCTION and unverified against production. Tables the stack cannot create are UNVERIFIED, not passing.
BEGIN;
SET LOCAL session_replication_role = replica;

-- helpers (rolled back with the file) -------------------------------------------------------------------------------------
-- Rows of public.<t> that belong to T_A or carry a CANARY_A marker, as seen by the CURRENT role (RLS applies to a non-owner).
CREATE FUNCTION tap.mt_cnt(p_table text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE c bigint; v_pred text;
BEGIN
  v_pred := 'to_jsonb(t)::text LIKE ''%CANARY\_A\_%''';
  IF p_table = 'tenants' THEN NULL;  -- a tenant row is keyed by id; it carries no tenant_id column
  ELSE v_pred := v_pred || ' OR t.tenant_id = ''aaaaaaaa-0000-4000-8000-00000000000a''::uuid'; END IF;
  EXECUTE format('SELECT count(*) FROM public.%I t WHERE %s', p_table, v_pred) INTO c;
  RETURN c;
END $$;

-- the subject tables: 18 tenant tables (docs/MULTI-TENANT-PLAN.md section 2), the health tables, user_tenants
CREATE TABLE tap.mt_tables (name text PRIMARY KEY, kind text NOT NULL, mode text NOT NULL DEFAULT 'rows');
INSERT INTO tap.mt_tables (name, kind) VALUES
  ('access_audit_log','tenant'),('community_groups','tenant'),('community_listings','tenant'),('community_meetups','tenant'),
  ('consents','tenant'),('d42_domain_weights','tenant'),('event_attendance','tenant'),('live_highlights','tenant'),
  ('live_room_attendance','tenant'),('live_rooms','tenant'),('products_catalog','tenant'),('relationship_edges','tenant'),
  ('retrieval_traces','tenant'),('role_sessions','tenant'),('services_catalog','tenant'),('tenant_catalog_overrides','tenant'),
  ('tenants','tenant'),('user_roles','tenant'),('user_tenants','membership');
INSERT INTO tap.mt_tables (name, kind)
  SELECT btrim(x), 'health' FROM unnest(string_to_array(coalesce(current_setting('mt.health_tables', true), ''), ',')) AS x
  WHERE btrim(x) <> '' ON CONFLICT (name) DO NOTHING;
-- tenants is a reference table: every authenticated user may list it (policy tenants_select_authenticated USING (true)), so the
-- claim for it is "no CANARY_A content is reachable", not "no T_A row".
UPDATE tap.mt_tables SET mode = 'public_ref' WHERE name = 'tenants';
ALTER TABLE tap.mt_tables ADD COLUMN present boolean, ADD COLUMN listed boolean;
UPDATE tap.mt_tables t SET present = to_regclass('public.' || quote_ident(t.name)) IS NOT NULL,
  listed = EXISTS (SELECT 1 FROM tap.not_replayable n WHERE n.table_name = t.name);

-- write checks: a b_member insert carrying a T_A tenant_id must be rejected by RLS (42501); the control is the same insert with
-- a T_B tenant_id, which proves the rejection comes from the tenant and not from a malformed statement.
CREATE TABLE tap.mt_write (table_name text PRIMARY KEY, reject_sql text NOT NULL, control_sql text);
INSERT INTO tap.mt_write VALUES
  ('community_groups',
   $s$INSERT INTO public.community_groups (tenant_id, name, topic_key) VALUES ('aaaaaaaa-0000-4000-8000-00000000000a', 'mt_w_a', 'mt_w')$s$,
   $s$INSERT INTO public.community_groups (tenant_id, name, topic_key) VALUES ('bbbbbbbb-0000-4000-8000-00000000000b', 'mt_w_b', 'mt_w')$s$),
  ('community_meetups',
   $s$INSERT INTO public.community_meetups (tenant_id, group_id, title, starts_at, ends_at, location_text, mode) VALUES ('aaaaaaaa-0000-4000-8000-00000000000a', 'c0a00000-0000-4000-8000-0000000000a1', 'mt_w_a', '2030-01-01T10:00:00Z', '2030-01-01T11:00:00Z', 'nowhere', 'online')$s$,
   $s$INSERT INTO public.community_meetups (tenant_id, group_id, title, starts_at, ends_at, location_text, mode) VALUES ('bbbbbbbb-0000-4000-8000-00000000000b', 'c0b00000-0000-4000-8000-0000000000b1', 'mt_w_b', '2030-01-01T10:00:00Z', '2030-01-01T11:00:00Z', 'nowhere', 'online')$s$),
  ('services_catalog',
   $s$INSERT INTO public.services_catalog (tenant_id, name, service_type) VALUES ('aaaaaaaa-0000-4000-8000-00000000000a', 'mt_w_a', 'other')$s$,
   $s$INSERT INTO public.services_catalog (tenant_id, name, service_type) VALUES ('bbbbbbbb-0000-4000-8000-00000000000b', 'mt_w_b', 'other')$s$),
  ('products_catalog',
   $s$INSERT INTO public.products_catalog (tenant_id, name, product_type) VALUES ('aaaaaaaa-0000-4000-8000-00000000000a', 'mt_w_a', 'other')$s$,
   $s$INSERT INTO public.products_catalog (tenant_id, name, product_type) VALUES ('bbbbbbbb-0000-4000-8000-00000000000b', 'mt_w_b', 'other')$s$),
  ('relationship_edges',
   $s$INSERT INTO public.relationship_edges (tenant_id, user_id, from_node_id, to_node_id, relationship_type, origin) VALUES ('aaaaaaaa-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000001', 'c0a00000-0000-4000-8000-0000000000e1', 'c0a00000-0000-4000-8000-0000000000e2', 'friend', 'system')$s$,
   $s$INSERT INTO public.relationship_edges (tenant_id, user_id, from_node_id, to_node_id, relationship_type, origin) VALUES ('bbbbbbbb-0000-4000-8000-00000000000b', '0000000b-0000-4000-8000-000000000001', 'c0b00000-0000-4000-8000-0000000000e3', 'c0b00000-0000-4000-8000-0000000000e4', 'friend', 'system')$s$),
  ('health_features_daily',
   $s$INSERT INTO public.health_features_daily (tenant_id, user_id, date, feature_key, feature_value) VALUES ('aaaaaaaa-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000001', '2030-02-01', 'mt_w', 1)$s$,
   $s$INSERT INTO public.health_features_daily (tenant_id, user_id, date, feature_key, feature_value) VALUES ('bbbbbbbb-0000-4000-8000-00000000000b', '0000000b-0000-4000-8000-000000000001', '2030-02-01', 'mt_w', 1)$s$),
  ('biomarker_results',
   $s$INSERT INTO public.biomarker_results (tenant_id, user_id, measured_at) VALUES ('aaaaaaaa-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000001', '2030-02-01T00:00:00Z')$s$,
   $s$INSERT INTO public.biomarker_results (tenant_id, user_id, measured_at) VALUES ('bbbbbbbb-0000-4000-8000-00000000000b', '0000000b-0000-4000-8000-000000000001', '2030-02-01T00:00:00Z')$s$),
  ('wearable_samples',
   $s$INSERT INTO public.wearable_samples (tenant_id, user_id, ts, value) VALUES ('aaaaaaaa-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000001', '2030-02-01T00:00:00Z', 1)$s$,
   $s$INSERT INTO public.wearable_samples (tenant_id, user_id, ts, value) VALUES ('bbbbbbbb-0000-4000-8000-00000000000b', '0000000b-0000-4000-8000-000000000001', '2030-02-01T00:00:00Z', 1)$s$),
  -- no INSERT policy for authenticated on these three: default deny, so there is no control insert
  ('d42_domain_weights',
   $s$INSERT INTO public.d42_domain_weights (tenant_id, domain) VALUES ('aaaaaaaa-0000-4000-8000-00000000000a', 'health_wellbeing')$s$, NULL),
  ('tenants',
   $s$INSERT INTO public.tenants (id, slug, name) VALUES ('aaaaaaaa-0000-4000-8000-0000000000ff', 'mt-w-a', 'MT write probe')$s$, NULL),
  ('user_tenants',
   $s$INSERT INTO public.user_tenants (tenant_id, user_id, active_role) VALUES ('aaaaaaaa-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000001', 'community')$s$, NULL);
ALTER TABLE tap.mt_write ADD COLUMN present boolean;
UPDATE tap.mt_write w SET present = to_regclass('public.' || quote_ident(w.table_name)) IS NOT NULL;
GRANT ALL ON ALL TABLES IN SCHEMA tap TO PUBLIC;

-- seed: extra T_A / T_B rows, in this transaction only, so a zero below is never a zero because the table was empty. The shared
-- fixtures (supabase/tests/fixtures) already carry CANARY rows in four tables, tenants and user_tenants.
INSERT INTO public.d42_domain_weights (tenant_id, domain, base_weight, override_reason) VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'health_wellbeing', 10, 'CANARY_A_5d0f1c2e-0000-4000-8000-00000000ca11'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'health_wellbeing', 10, 'CANARY_B_5d0f1c2e-0000-4000-8000-00000000cb11');
INSERT INTO public.products_catalog (tenant_id, name, product_type) VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'CANARY_A_5d0f1c2e-0000-4000-8000-00000000ca12', 'other'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'CANARY_B_5d0f1c2e-0000-4000-8000-00000000cb12', 'other');
INSERT INTO public.relationship_nodes (id, tenant_id, node_type, title, domain) VALUES
  ('c0a00000-0000-4000-8000-0000000000e1', 'aaaaaaaa-0000-4000-8000-00000000000a', 'person', 'CANARY_A_5d0f1c2e-0000-4000-8000-00000000ca13', 'community'),
  ('c0a00000-0000-4000-8000-0000000000e2', 'aaaaaaaa-0000-4000-8000-00000000000a', 'person', 'CANARY_A_5d0f1c2e-0000-4000-8000-00000000ca14', 'community'),
  ('c0b00000-0000-4000-8000-0000000000e3', 'bbbbbbbb-0000-4000-8000-00000000000b', 'person', 'CANARY_B_5d0f1c2e-0000-4000-8000-00000000cb13', 'community'),
  ('c0b00000-0000-4000-8000-0000000000e4', 'bbbbbbbb-0000-4000-8000-00000000000b', 'person', 'CANARY_B_5d0f1c2e-0000-4000-8000-00000000cb14', 'community');
INSERT INTO public.relationship_edges (tenant_id, user_id, from_node_id, to_node_id, relationship_type, origin) VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a', '0000000a-0000-4000-8000-000000000001', 'c0a00000-0000-4000-8000-0000000000e1', 'c0a00000-0000-4000-8000-0000000000e2', 'friend', 'system');
INSERT INTO public.biomarker_results (tenant_id, user_id, name, measured_at) VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a', '0000000a-0000-4000-8000-000000000001', 'CANARY_A_5d0f1c2e-0000-4000-8000-00000000ca15', '2030-01-01T00:00:00Z'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', '0000000b-0000-4000-8000-000000000001', 'CANARY_B_5d0f1c2e-0000-4000-8000-00000000cb15', '2030-01-01T00:00:00Z');
INSERT INTO public.wearable_samples (tenant_id, user_id, metric, ts, value) VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a', '0000000a-0000-4000-8000-000000000001', 'CANARY_A_5d0f1c2e-0000-4000-8000-00000000ca16', '2030-01-01T00:00:00Z', 1),
  ('bbbbbbbb-0000-4000-8000-00000000000b', '0000000b-0000-4000-8000-000000000001', 'CANARY_B_5d0f1c2e-0000-4000-8000-00000000cb16', '2030-01-01T00:00:00Z', 1);
SET LOCAL session_replication_role = DEFAULT;

-- probe (before the plan, because the plan depends on its outcome): does a series ab_dual writes in the T_A context come back in
-- the T_B context? Uses its own key and date, so the assertions below do not depend on it.
CREATE TABLE tap.mt_probe (single_series boolean);
GRANT ALL ON tap.mt_probe TO PUBLIC;
SELECT set_config('request.jwt.claims', '{"sub":"0000000c-0000-4000-8000-000000000001","role":"authenticated","tenant_id":"aaaaaaaa-0000-4000-8000-00000000000a"}', false);
SET ROLE authenticated;
INSERT INTO public.health_features_daily (tenant_id, user_id, date, feature_key, feature_value) VALUES ('aaaaaaaa-0000-4000-8000-00000000000a', '0000000c-0000-4000-8000-000000000001', '2030-03-02', 'mt_probe', 1);
SELECT set_config('request.jwt.claims', '{"sub":"0000000c-0000-4000-8000-000000000001","role":"authenticated","tenant_id":"bbbbbbbb-0000-4000-8000-00000000000b"}', false);
INSERT INTO tap.mt_probe SELECT count(*) = 1 FROM public.health_features_daily WHERE feature_key = 'mt_probe';
RESET ROLE;

-- plan ---------------------------------------------------------------------------------------------------------------------
-- fixed: 1 drift check + 3 ab_dual checks. per present table: 'rows' = 2 (T_A rows exist, b_member sees none), 'public_ref' = 1.
-- per present write row: 1 reject + 1 control when there is one. per absent table: 1 when strict or not a listed table.
-- one-series check: 1 when it holds, or in strict mode (where it fails); otherwise it is reported UNVERIFIED and not counted.
SELECT plan((
  4
  + (SELECT coalesce(sum(CASE WHEN mode = 'rows' THEN 2 ELSE 1 END), 0) FROM tap.mt_tables WHERE present)
  + (SELECT coalesce(sum(CASE WHEN control_sql IS NULL THEN 1 ELSE 2 END), 0) FROM tap.mt_write WHERE present)
  + (SELECT count(*) FROM tap.mt_tables WHERE NOT present AND (NOT listed OR coalesce(current_setting('mt.strict', true), '1') = '1'))
  + (SELECT CASE WHEN (SELECT bool_and(single_series) FROM tap.mt_probe) OR coalesce(current_setting('mt.strict', true), '1') = '1' THEN 1 ELSE 0 END)
)::int);

SELECT diag('NON-PRODUCTION tenant resolution: claims carry tenant_id, replayed current_tenant_id() body; skipped migrations redefine tenant resolution and policies on present tables (docs/multitenancy/LOCAL-STACK.md)');
SELECT diag('mode: ' || CASE WHEN coalesce(current_setting('mt.strict', true), '1') = '1' THEN 'strict (unverified tables FAIL)' ELSE 'report (unverified tables are listed, never counted as passed)' END);

-- P1a: the subject set equals the required-tables list (no table silently dropped or added)
SELECT set_eq(
  $q$SELECT name FROM tap.mt_tables$q$,
  $q$SELECT btrim(x) FROM unnest(string_to_array(current_setting('mt.required_tables', true), ',')) AS x WHERE btrim(x) <> ''$q$,
  'suite subjects = required-tables.txt (18 tenant tables + health tables from health-tables.json + user_tenants)');

-- tables the stack cannot create: strict => fail via require_table; otherwise UNVERIFIED (never ok)
SELECT CASE WHEN t.listed AND coalesce(current_setting('mt.strict', true), '1') = '0'
            THEN '# UNVERIFIED ' || t.name || ': not replayable on PGlite (' || (SELECT n.reason FROM tap.not_replayable n WHERE n.table_name = t.name) || '); no isolation claim is made'
            ELSE tap.require_table(t.name, 'isolation of ' || t.name || ' can be checked (table is replayed)') END
FROM tap.mt_tables t WHERE NOT t.present ORDER BY t.name;

-- P1b: non-vacuous. As the owner (RLS bypassed) T_A / CANARY_A rows exist in each present table (tenants is a reference table)
SELECT ok(tap.mt_cnt(t.name) > 0, t.name || ': T_A / CANARY_A rows exist (a zero below is not an empty table)')
FROM tap.mt_tables t WHERE t.present AND t.mode = 'rows' ORDER BY t.name;

-- P1c: b_member (member of T_B only, claims tenant_id = T_B) sees 0 T_A / CANARY_A rows
SELECT set_config('request.jwt.claims', '{"sub":"0000000b-0000-4000-8000-000000000001","role":"authenticated","tenant_id":"bbbbbbbb-0000-4000-8000-00000000000b"}', false);
SET ROLE authenticated;
SELECT is(tap.mt_cnt(t.name), 0::bigint,
  t.name || CASE WHEN t.kind = 'health' THEN ' (health): ' ELSE ': ' END || 'b_member sees 0 T_A / CANARY_A rows'
  || CASE WHEN t.mode = 'public_ref' THEN ' of content (tenant rows are listable by policy USING (true))' ELSE '' END)
FROM tap.mt_tables t WHERE t.present ORDER BY t.name;

-- P2a: b_member write with a T_A tenant_id is rejected by RLS (42501); the T_B control insert is accepted
SELECT tap.throws_ok(w.reject_sql, '42501', NULL, w.table_name || ': b_member insert with a T_A tenant_id is rejected by RLS')
FROM tap.mt_write w WHERE w.present ORDER BY w.table_name;
SELECT tap.lives_ok(w.control_sql, w.table_name || ': control, the same insert with a T_B tenant_id is accepted')
FROM tap.mt_write w WHERE w.present AND w.control_sql IS NOT NULL ORDER BY w.table_name;
RESET ROLE;

-- P2b: ab_dual (member of T_A and T_B) and the health series. Health data is member-owned (docs/MULTI-TENANT-PLAN.md section 9);
-- the replayed health_features_daily policy scopes by tenant_id = current_tenant_id() AND user_id, so a series written in one
-- tenant context is not read back from the other. That is the replayed policy, not production's (the policy is rewritten in the
-- skipped migration 20251231000000_vtid_01103_health_compute_engine.sql), so the one-series claim is reported UNVERIFIED unless it holds.
SELECT set_config('request.jwt.claims', '{"sub":"0000000c-0000-4000-8000-000000000001","role":"authenticated","tenant_id":"aaaaaaaa-0000-4000-8000-00000000000a"}', false);
SET ROLE authenticated;
SELECT lives_ok($q$INSERT INTO public.health_features_daily (tenant_id, user_id, date, feature_key, feature_value) VALUES ('aaaaaaaa-0000-4000-8000-00000000000a', '0000000c-0000-4000-8000-000000000001', '2030-03-01', 'mt_series', 1)$q$,
  'ab_dual writes a health row in the T_A context');
SELECT is((SELECT count(*) FROM public.health_features_daily WHERE user_id = '0000000c-0000-4000-8000-000000000001' AND feature_key = 'mt_series'), 1::bigint,
  'ab_dual reads the series it wrote, in the T_A context');
SELECT is((SELECT count(*) FROM public.health_features_daily WHERE user_id <> '0000000c-0000-4000-8000-000000000001'), 0::bigint,
  'ab_dual sees no other member''s health rows (health data is member-private)');
SELECT set_config('request.jwt.claims', '{"sub":"0000000c-0000-4000-8000-000000000001","role":"authenticated","tenant_id":"bbbbbbbb-0000-4000-8000-00000000000b"}', false);
SELECT CASE
  WHEN (SELECT count(*) FROM public.health_features_daily WHERE user_id = '0000000c-0000-4000-8000-000000000001' AND feature_key = 'mt_series') = 1
    THEN ok(true, 'ab_dual reads the same single health series from the T_B context')
  WHEN coalesce(current_setting('mt.strict', true), '1') = '1'
    THEN ok(false, 'ab_dual reads the same single health series from the T_B context') || E'\n#   unverified: the replayed policy scopes health rows by tenant_id'
  ELSE '# UNVERIFIED ab_dual single health series across contexts: the replayed policy scopes rows by tenant_id = current_tenant_id(); production policy is in a skipped migration; no claim is made' END;
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
