-- VTID-05506 (mt-m3-r2/provision-erp-monitoring-db) — pgTAP:
--   E1 provision_tenant() records tenant_settings.feature_flags.erp.bootstrap_requested (idempotent, also on a re-run),
--   E2 `erp` is a governed key in tenant_settings_merge_feature_flags(),
--   E3 ci_tenant_isolation_health_by_tenant() sums to the unchanged ci_tenant_isolation_health().
-- Runs on a throwaway Postgres after supabase/tests/vtid_05150_fixture.sql, the real 20261014000100 (+ fixture part 2),
-- 20261014000300, 20261014000400, 20261014000500 and 20261102141000..141100_vtid_05506_*.sql.
-- One transaction, rolled back at the end: never against a shared or live database.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(60);

CREATE TEMP TABLE k AS SELECT
  'a0000000-0000-4000-8000-000000000001'::uuid AS exafy,
  '2e7528b8-472a-4356-88da-0280d4639cce'::uuid AS maxina,
  '73cc592f-84ec-457a-b0f7-25a082d7e011'::uuid AS alkalma,
  'b0000000-0000-4000-8000-000000000001'::uuid AS handmade;

-- ═══ E1: provision_tenant() records the ERP bootstrap request ═══════════════════════════════════════════════════
-- First provisioning.
CREATE TEMP TABLE r1 AS SELECT public.provision_tenant('ermco', 'Erm Co', 'admin@ermco.io', (SELECT exafy FROM k), 'Alle zusammen',
  p_display_name => 'Erm Co', p_jev_monthly_budget_usd => 25) AS j;

SELECT is((SELECT feature_flags #> '{erp,bootstrap_requested}' FROM public.tenant_settings WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid),
  'true'::jsonb, '01 first provision sets erp.bootstrap_requested = true');
SELECT is((SELECT feature_flags FROM public.tenant_settings WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid),
  '{"jev":{"enabled":true,"planes":["internal","system_autopilot","member"],"monthly_budget_usd":25},"erp":{"bootstrap_requested":true}}'::jsonb,
  '02 feature_flags is the jev flag (Alkalma pattern) plus exactly the erp request');
SELECT is((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys((SELECT j FROM r1)) k),
  ARRAY['created','ensured','invitation','slug','tenant_id'], '03 the returned jsonb keeps its shape (no erp key added)');
SELECT ok((SELECT (j ->> 'created')::boolean AND j ->> 'slug' = 'ermco' AND (j #>> '{invitation,reused}') = 'false' FROM r1),
  '04 created:true, slug echoed, new invitation');
SELECT ok((SELECT display_name = 'Erm Co' AND currency = 'EUR' AND default_locale = 'de' AND provisioned_at IS NOT NULL
             AND provisioned_by = (SELECT exafy FROM k)
             FROM public.tenant_settings WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid),
  '05 brand-pack settings are written as before');
SELECT is((SELECT (j #>> '{ensured,system_group}')::int FROM r1), 1, '06 the Vitana bot is in the system group as before');
SELECT ok((SELECT (j #>> '{ensured,notification_controls}')::int > 0 AND (j #>> '{ensured,ai_policies}')::int = 2
                  AND (j #>> '{ensured,autopilot_settings}')::int = 1 FROM r1), '07 the instance data is ensured as before');

-- Re-run of the already provisioned tenant (flag already true): idempotent, nothing rewritten.
CREATE TEMP TABLE before_rerun AS
  SELECT feature_flags, updated_at, updated_by FROM public.tenant_settings WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid;
CREATE TEMP TABLE r2 AS SELECT public.provision_tenant('ermco', 'Erm Co', 'admin@ermco.io', (SELECT exafy FROM k), 'Alle zusammen',
  p_display_name => 'Erm Co', p_jev_monthly_budget_usd => 25) AS j;
SELECT ok((SELECT NOT (j ->> 'created')::boolean AND (j #>> '{invitation,reused}') = 'true' FROM r2), '08 a re-run is created:false and reuses the invitation');
SELECT is((SELECT feature_flags FROM public.tenant_settings WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid),
  (SELECT feature_flags FROM before_rerun), '09 a re-run leaves feature_flags identical (the flag is true exactly once)');
SELECT ok((SELECT s.updated_at = b.updated_at AND s.updated_by IS NOT DISTINCT FROM b.updated_by
             FROM public.tenant_settings s, before_rerun b WHERE s.tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid),
  '10 the guard makes a re-run a no-op (updated_at / updated_by untouched)');
SELECT is((SELECT count(*)::int FROM public.tenant_settings WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid), 1, '11 still one settings row');

-- A tenant provisioned BEFORE this migration (flag absent), then re-run: the flag is recorded.
UPDATE public.tenant_settings SET feature_flags = feature_flags - 'erp' WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid;
SELECT is((SELECT feature_flags ? 'erp' FROM public.tenant_settings WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid), false,
  '12 (setup) the pre-migration shape has no erp key');
SELECT lives_ok($$SELECT public.provision_tenant('ermco', 'Erm Co', 'admin@ermco.io', 'a0000000-0000-4000-8000-000000000001', 'Alle zusammen',
  p_display_name => 'Erm Co', p_jev_monthly_budget_usd => 25)$$, '13 re-running an already provisioned tenant works');
SELECT is((SELECT feature_flags #> '{erp,bootstrap_requested}' FROM public.tenant_settings WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid),
  'true'::jsonb, '14 the re-run of a pre-migration tenant records the flag (UPDATE after the ON CONFLICT DO NOTHING insert)');
SELECT is((SELECT feature_flags -> 'jev' FROM public.tenant_settings WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid),
  '{"enabled":true,"planes":["internal","system_autopilot","member"],"monthly_budget_usd":25}'::jsonb, '15 the stored jev flag is kept whole');

-- Other erp subkeys are kept.
UPDATE public.tenant_settings SET feature_flags = jsonb_set(feature_flags, '{erp}', '{"bridge":"x","bootstrap_requested":false}')
 WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid;
SELECT public.provision_tenant('ermco', 'Erm Co', 'admin@ermco.io', (SELECT exafy FROM k), 'Alle zusammen', p_display_name => 'Erm Co', p_jev_monthly_budget_usd => 25);
SELECT is((SELECT feature_flags -> 'erp' FROM public.tenant_settings WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid),
  '{"bridge":"x","bootstrap_requested":true}'::jsonb, '16 a false flag becomes true and other erp subkeys are kept');

-- A non-object erp value is repaired (string, JSON null, array).
UPDATE public.tenant_settings SET feature_flags = jsonb_set(feature_flags, '{erp}', '"yes"') WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid;
SELECT public.provision_tenant('ermco', 'Erm Co', 'admin@ermco.io', (SELECT exafy FROM k), 'Alle zusammen', p_display_name => 'Erm Co', p_jev_monthly_budget_usd => 25);
SELECT is((SELECT feature_flags -> 'erp' FROM public.tenant_settings WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid),
  '{"bootstrap_requested":true}'::jsonb, '17 a string erp value is repaired to an object holding the flag');
UPDATE public.tenant_settings SET feature_flags = jsonb_set(feature_flags, '{erp}', 'null'::jsonb) WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid;
SELECT public.provision_tenant('ermco', 'Erm Co', 'admin@ermco.io', (SELECT exafy FROM k), 'Alle zusammen', p_display_name => 'Erm Co', p_jev_monthly_budget_usd => 25);
SELECT is((SELECT feature_flags -> 'erp' FROM public.tenant_settings WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid),
  '{"bootstrap_requested":true}'::jsonb, '18 a JSON-null erp value is repaired');
UPDATE public.tenant_settings SET feature_flags = jsonb_set(feature_flags, '{erp}', '[1,2]'::jsonb) WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid;
SELECT public.provision_tenant('ermco', 'Erm Co', 'admin@ermco.io', (SELECT exafy FROM k), 'Alle zusammen', p_display_name => 'Erm Co', p_jev_monthly_budget_usd => 25);
SELECT is((SELECT feature_flags -> 'erp' FROM public.tenant_settings WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid),
  '{"bootstrap_requested":true}'::jsonb, '19 an array erp value is repaired');

-- Refusals and the legacy tenants are unchanged.
SELECT throws_ok($$SELECT public.provision_tenant('handmade', 'Other', 'admin@x.io', 'a0000000-0000-4000-8000-000000000001', 'All')$$,
  '22023', 'SLUG_TAKEN', '20 a hand-made slug is still SLUG_TAKEN');
SELECT throws_ok($$SELECT public.provision_tenant('maxina', 'X Co', 'admin@x.io', 'a0000000-0000-4000-8000-000000000001', 'All')$$,
  '22023', 'RESERVED_SLUG', '21 a reserved slug is still refused');
SELECT is((SELECT count(*)::int FROM public.tenant_settings WHERE feature_flags ? 'erp'), 1,
  '22 only the provisioned tenant carries an erp key (legacy and hand-made tenants untouched)');
SELECT is((SELECT feature_flags FROM public.tenant_settings WHERE tenant_id = (SELECT handmade FROM k)), '{}'::jsonb, '23 the hand-made tenant keeps empty feature_flags');
SELECT is((SELECT feature_flags FROM public.tenant_settings WHERE tenant_id = (SELECT alkalma FROM k)),
  '{"jev":{"planes":["internal","system_autopilot","member"],"enabled":true,"monthly_budget_usd":10}}'::jsonb, '24 alkalma feature_flags untouched');

-- provision_tenant keeps its definition: SECURITY DEFINER, pinned search_path, service_role only.
SELECT ok((SELECT prosecdef AND proconfig = ARRAY['search_path=public'] FROM pg_proc
            WHERE oid = to_regprocedure('public.provision_tenant(text,text,text,uuid,text,text,numeric,text,text[],text,text)')),
  '25 provision_tenant is SECURITY DEFINER with search_path = public');
SELECT ok(has_function_privilege('service_role', 'public.provision_tenant(text,text,text,uuid,text,text,numeric,text,text[],text,text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.provision_tenant(text,text,text,uuid,text,text,numeric,text,text[],text,text)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.provision_tenant(text,text,text,uuid,text,text,numeric,text,text[],text,text)', 'EXECUTE'),
  '26 provision_tenant: service_role only');

-- ═══ E2: `erp` is a governed key in the feature_flags merge ═════════════════════════════════════════════════════
CREATE TEMP TABLE m0 AS
  SELECT feature_flags AS ff FROM public.tenant_settings WHERE tenant_id = (SELECT tid FROM (SELECT ((SELECT j FROM r1) ->> 'tenant_id')::uuid AS tid) q);
SELECT public.tenant_settings_merge_feature_flags(((SELECT j FROM r1) ->> 'tenant_id')::uuid,
  '{"erp":{"bootstrap_requested":false,"bridge":"evil"},"jev":{"enabled":false},"enable_autopilot":false}'::jsonb, false, (SELECT exafy FROM k));
SELECT is((SELECT feature_flags -> 'erp' FROM public.tenant_settings WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid),
  '{"bootstrap_requested":true}'::jsonb, '27 p_allow_governed = false: the stored erp flag is intact');
SELECT is((SELECT feature_flags -> 'jev' FROM public.tenant_settings WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid),
  (SELECT ff -> 'jev' FROM m0), '28 p_allow_governed = false: the stored jev flag is intact');
SELECT is((SELECT feature_flags -> 'enable_autopilot' FROM public.tenant_settings WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid),
  'false'::jsonb, '29 an ordinary key still merges for a tenant admin');
SELECT is((SELECT feature_flags - 'enable_autopilot' FROM public.tenant_settings WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid),
  (SELECT ff FROM m0), '30 nothing else changed in feature_flags');
SELECT is(public.tenant_settings_merge_feature_flags(((SELECT j FROM r1) ->> 'tenant_id')::uuid, '{"erp":{"x":1}}'::jsonb, false, (SELECT exafy FROM k)) #> '{feature_flags,erp}',
  '{"bootstrap_requested":true}'::jsonb, '31 the RETURNING row shows the intact erp flag');
SELECT public.tenant_settings_merge_feature_flags(((SELECT j FROM r1) ->> 'tenant_id')::uuid,
  '{"erp":{"bootstrap_requested":true,"bridge":"ok"},"jev":{"enabled":true,"planes":["internal"],"monthly_budget_usd":20}}'::jsonb, true, (SELECT exafy FROM k));
SELECT is((SELECT feature_flags -> 'erp' FROM public.tenant_settings WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid),
  '{"bootstrap_requested":true,"bridge":"ok"}'::jsonb, '32 p_allow_governed = true (exafy_admin) can replace erp');
SELECT is((SELECT feature_flags #>> '{jev,monthly_budget_usd}' FROM public.tenant_settings WHERE tenant_id = ((SELECT j FROM r1) ->> 'tenant_id')::uuid),
  '20', '33 p_allow_governed = true can still replace jev');
-- A tenant with no settings row yet: the non-governed insert path also drops erp and jev.
DELETE FROM public.tenant_settings WHERE tenant_id = (SELECT handmade FROM k);
SELECT is(public.tenant_settings_merge_feature_flags((SELECT handmade FROM k), '{"erp":{"bootstrap_requested":true},"jev":{"enabled":true},"a":1}'::jsonb, false, (SELECT exafy FROM k)) -> 'feature_flags',
  '{"a":1}'::jsonb, '34 the insert path of a non-governed caller drops erp and jev');
SELECT ok((SELECT NOT p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_catalog'] FROM pg_proc p
            WHERE p.oid = to_regprocedure('public.tenant_settings_merge_feature_flags(uuid,jsonb,boolean,uuid)')),
  '35 the merge function stays SECURITY INVOKER with its pinned search_path');
SELECT ok(has_function_privilege('service_role', 'public.tenant_settings_merge_feature_flags(uuid,jsonb,boolean,uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.tenant_settings_merge_feature_flags(uuid,jsonb,boolean,uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.tenant_settings_merge_feature_flags(uuid,jsonb,boolean,uuid)', 'EXECUTE'),
  '36 the merge function: service_role only');

-- ═══ E3: ci_tenant_isolation_health_by_tenant() ═════════════════════════════════════════════════════════════════
-- Seed drift of every kind (this transaction is rolled back).
INSERT INTO public.tenants (tenant_id, name, slug, is_platform) VALUES ('c0000000-0000-4000-8000-0000000000f1', 'Platform', 'platformco', true);
INSERT INTO public.chat_messages (id, tenant_id, body) VALUES
  (gen_random_uuid(), 'dead0000-0000-4000-8000-000000000001', 'dangling-1'),     -- foreign (dangling tenant)
  (gen_random_uuid(), 'dead0000-0000-4000-8000-000000000001', 'dangling-2'),
  (gen_random_uuid(), 'dead0000-0000-4000-8000-000000000002', 'dangling-3'),
  (gen_random_uuid(), NULL, 'null-1'),                                            -- null tenant
  (gen_random_uuid(), NULL, 'null-2');
INSERT INTO public.user_notifications (id, user_id, tenant_id, type) VALUES
  (gen_random_uuid(), NULL, 'dead0000-0000-4000-8000-000000000001', 'x'),
  (gen_random_uuid(), NULL, NULL, 'x');
-- user_tenants / memberships: u2 in maxina+ermco (primary maxina) consistent; u3 only in user_tenants (ermco) with no
-- primary; u4 only in memberships (alkalma); a dangling tenant on both sides; u2 with two primaries -> multi.
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES
  ((SELECT maxina FROM k), 'a0000000-0000-4000-8000-000000000002', true),
  (((SELECT j FROM r1) ->> 'tenant_id')::uuid, 'a0000000-0000-4000-8000-000000000002', true),
  (((SELECT j FROM r1) ->> 'tenant_id')::uuid, 'a0000000-0000-4000-8000-000000000003', false),
  ('dead0000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', true);
INSERT INTO public.memberships (user_id, tenant_id) VALUES
  ('a0000000-0000-4000-8000-000000000002', (SELECT maxina FROM k)),
  ('a0000000-0000-4000-8000-000000000002', ((SELECT j FROM r1) ->> 'tenant_id')::uuid),
  ('a0000000-0000-4000-8000-000000000004', (SELECT alkalma FROM k)),
  ('a0000000-0000-4000-8000-000000000004', 'dead0000-0000-4000-8000-000000000004');

-- Capture once (a missing function leaves bt empty, so the assertions below fail instead of aborting the script).
CREATE TEMP TABLE bt (j jsonb);
CREATE TEMP TABLE ci (j jsonb);
INSERT INTO ci SELECT public.ci_tenant_isolation_health()::jsonb;
DO $$ BEGIN
  INSERT INTO bt SELECT public.ci_tenant_isolation_health_by_tenant()::jsonb;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

SELECT ok((SELECT j IS NOT NULL AND jsonb_typeof(j -> 'tenants') = 'array' AND jsonb_typeof(j -> 'totals') = 'object'
                  AND j ? 'generated_at' AND jsonb_typeof(j -> 'scan_errors') = 'array' FROM bt),
  '37 returns {generated_at, tenants[], totals{}, scan_errors[]}');
SELECT ok((SELECT j -> 'scan_errors' = '[]'::jsonb FROM bt), '38 no scan errors');
SELECT ok((SELECT (SELECT count(*) FROM jsonb_array_elements(j -> 'tenants') e WHERE (e ->> 'is_registered')::boolean) = (SELECT count(*) FROM public.tenants) FROM bt),
  '39 every registered tenant is listed');
SELECT ok((SELECT NOT EXISTS (
    SELECT 1 FROM public.tenants t WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(j -> 'tenants') e WHERE e ->> 'tenant_id' = t.tenant_id::text AND e ->> 'slug' = t.slug)) FROM bt),
  '40 each registered row carries its tenant_id and slug');
SELECT ok((SELECT e ->> 'foreign_tenant_rows' = '0' AND e ->> 'null_tenant_rows' = '0' AND e ->> 'memberships_not_in_user_tenants' = '0'
                  AND e ->> 'user_tenants_not_in_memberships' = '0' AND (e ->> 'is_registered')::boolean
             FROM bt, jsonb_array_elements(j -> 'tenants') e WHERE e ->> 'slug' = 'handmade'),
  '41 a clean tenant is listed with zeros');
SELECT ok((SELECT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j -> 'tenants') e, jsonb_each_text(e) c
                               WHERE c.key NOT IN ('tenant_id','slug','is_registered') AND c.value IS NULL) FROM bt),
  '42 no count column is null in any row');

-- Sum of every column over all rows equals ci_tenant_isolation_health(), and totals equals that sum.
SELECT is_empty($$
  SELECT c FROM unnest(ARRAY['foreign_tenant_rows','null_tenant_rows','users_zero_primary','users_multi_primary','auth_users_without_membership',
                             'memberships_not_in_user_tenants','user_tenants_not_in_memberships','default_tenant_count','platform_tenant_count']) c
  WHERE (SELECT coalesce(sum((e ->> c)::bigint), -1) FROM bt, jsonb_array_elements(bt.j -> 'tenants') e) IS DISTINCT FROM (SELECT (ci.j ->> c)::bigint FROM ci)$$,
  '43 for every column the per-tenant rows sum to ci_tenant_isolation_health()');
SELECT is_empty($$
  SELECT c FROM unnest(ARRAY['foreign_tenant_rows','null_tenant_rows','users_zero_primary','users_multi_primary','auth_users_without_membership',
                             'memberships_not_in_user_tenants','user_tenants_not_in_memberships','default_tenant_count','platform_tenant_count']) c
  WHERE (SELECT (bt.j -> 'totals' ->> c)::bigint FROM bt) IS DISTINCT FROM (SELECT (ci.j ->> c)::bigint FROM ci)$$,
  '44 totals equals ci_tenant_isolation_health() for every column');
SELECT ok((SELECT (j ->> 'foreign_tenant_rows')::int = 6 AND (j ->> 'null_tenant_rows')::int = 3 AND (j ->> 'memberships_not_in_user_tenants')::int > 0
                  AND (j ->> 'user_tenants_not_in_memberships')::int > 0 AND (j ->> 'users_multi_primary')::int > 0
                  AND (j ->> 'users_zero_primary')::int > 0 AND (j ->> 'auth_users_without_membership')::int > 0
                  AND (j ->> 'platform_tenant_count')::int = 1 AND (j ->> 'default_tenant_count')::int = 1 FROM ci),
  '45 (setup) the seeded drift is non-trivial in every column');

-- Per-tenant attribution.
SELECT is((SELECT (e ->> 'foreign_tenant_rows')::int FROM bt, jsonb_array_elements(j -> 'tenants') e WHERE e ->> 'tenant_id' = 'dead0000-0000-4000-8000-000000000001'),
  3, '46 a dangling tenant id gets its own row with its foreign rows (2 chat_messages + 1 user_notifications)');
SELECT ok((SELECT NOT (e ->> 'is_registered')::boolean AND e -> 'slug' = 'null'::jsonb
             FROM bt, jsonb_array_elements(j -> 'tenants') e WHERE e ->> 'tenant_id' = 'dead0000-0000-4000-8000-000000000001'),
  '47 a dangling tenant row has is_registered = false and slug null');
SELECT is((SELECT (e ->> 'user_tenants_not_in_memberships')::int FROM bt, jsonb_array_elements(j -> 'tenants') e WHERE e ->> 'tenant_id' = 'dead0000-0000-4000-8000-000000000003'),
  1, '48 a dangling tenant id from user_tenants drift is attributed to it');
SELECT is((SELECT (e ->> 'memberships_not_in_user_tenants')::int FROM bt, jsonb_array_elements(j -> 'tenants') e WHERE e ->> 'tenant_id' = 'dead0000-0000-4000-8000-000000000004'),
  1, '49 a dangling tenant id from memberships drift is attributed to it');
SELECT is((SELECT (e ->> 'memberships_not_in_user_tenants')::int FROM bt, jsonb_array_elements(j -> 'tenants') e WHERE e ->> 'slug' = 'alkalma'),
  1, '50 a membership without user_tenants is attributed to its tenant');
SELECT is((SELECT (e ->> 'user_tenants_not_in_memberships')::int FROM bt, jsonb_array_elements(j -> 'tenants') e WHERE e ->> 'slug' = 'ermco'),
  1, '51 a user_tenants row without membership is attributed to its tenant');
SELECT ok((SELECT e ->> 'null_tenant_rows' = '3' AND e ->> 'foreign_tenant_rows' = '0' AND NOT (e ->> 'is_registered')::boolean
                  AND (e ->> 'users_multi_primary')::int > 0 AND (e ->> 'users_zero_primary')::int > 0 AND (e ->> 'auth_users_without_membership')::int > 0
             FROM bt, jsonb_array_elements(j -> 'tenants') e WHERE e -> 'tenant_id' = 'null'::jsonb),
  '52 rows with no tenant (null tenant_id, zero/multi primary users, auth users without membership) sit in the one tenant_id null row');
SELECT is((SELECT count(*)::int FROM bt, jsonb_array_elements(j -> 'tenants') e WHERE e -> 'tenant_id' = 'null'::jsonb), 1, '53 exactly one tenant_id null row');
SELECT ok((SELECT (e ->> 'default_tenant_count')::int = 1 FROM bt, jsonb_array_elements(j -> 'tenants') e WHERE e ->> 'slug' = 'maxina')
          AND (SELECT (e ->> 'platform_tenant_count')::int = 1 FROM bt, jsonb_array_elements(j -> 'tenants') e WHERE e ->> 'slug' = 'platformco'),
  '54 default and platform flags are attributed to their own tenants');

-- Grants, definition and the untouched siblings.
SELECT ok(CASE WHEN to_regprocedure('public.ci_tenant_isolation_health_by_tenant()') IS NULL THEN false ELSE
            has_function_privilege('service_role', 'public.ci_tenant_isolation_health_by_tenant()', 'EXECUTE')
            AND NOT has_function_privilege('anon', 'public.ci_tenant_isolation_health_by_tenant()', 'EXECUTE')
            AND NOT has_function_privilege('authenticated', 'public.ci_tenant_isolation_health_by_tenant()', 'EXECUTE') END,
  '55 ci_tenant_isolation_health_by_tenant(): service_role only');
SELECT ok((SELECT p.prosecdef AND p.provolatile = 's' AND p.proconfig = ARRAY['search_path=public, pg_catalog'] AND p.prorettype = 'json'::regtype
             FROM pg_proc p WHERE p.oid = to_regprocedure('public.ci_tenant_isolation_health_by_tenant()')),
  '56 ci_tenant_isolation_health_by_tenant() is STABLE SECURITY DEFINER, search_path public, pg_catalog, returns json');
SELECT is((SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.ci_tenant_isolation_health()')),
  '526821628ec2954f2e5445ce3389b1c1', '57 ci_tenant_isolation_health() body is unchanged (md5 of 20261014000300)');
SELECT ok(has_function_privilege('service_role', 'public.ci_tenant_isolation_health()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.ci_tenant_isolation_health()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.ci_tenant_isolation_health()', 'EXECUTE'),
  '58 ci_tenant_isolation_health() grants unchanged');
-- The lane adds no policy and no table.
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE '%05506%'), 0, '59 the lane adds no policy');
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'ci_tenant_isolation_health_by_tenant'), 1,
  '60 exactly one by-tenant function (no overload)');

SELECT * FROM finish();
ROLLBACK;
