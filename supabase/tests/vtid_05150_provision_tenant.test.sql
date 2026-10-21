-- VTID-05150 SQL assertions, run by scripts/ci/test-vtid-05150-provision-tenant.sh
-- after the fixture, Lane A M1, and both VTID-05150 migrations (each applied twice).
\set ON_ERROR_STOP 1

-- Constants
CREATE TEMP TABLE k AS SELECT
  '2e7528b8-472a-4356-88da-0280d4639cce'::uuid AS maxina,
  '73cc592f-84ec-457a-b0f7-25a082d7e011'::uuid AS alkalma,
  'a0000000-0000-4000-8000-000000000001'::uuid AS exafy,
  'a0000000-0000-4000-8000-000000000002'::uuid AS plain;
GRANT SELECT ON k TO PUBLIC;

-- Snapshot of every legacy-tenant row in every table provisioning or the
-- migrations could touch, plus row counts of the member-facing tables.
CREATE FUNCTION pg_temp.legacy_snapshot() RETURNS TABLE (tbl text, digest text)
LANGUAGE plpgsql AS $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants','tenant_settings','notification_type_controls','ai_provider_policies',
                           'tenant_autopilot_settings','chat_groups','chat_group_members','tenant_invitations'] LOOP
    RETURN QUERY EXECUTE format(
      'SELECT %L::text, coalesce(md5(string_agg(row_to_json(x)::text, ''|'' ORDER BY row_to_json(x)::text)), ''empty'')
         FROM public.%I x WHERE x.tenant_id IN (SELECT maxina FROM k UNION ALL SELECT alkalma FROM k)', t, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['user_tenants','memberships','app_users','chat_messages','user_notifications','founding_members'] LOOP
    RETURN QUERY EXECUTE format('SELECT %L::text, (SELECT count(*) FROM public.%I)::text', t, t);
  END LOOP;
END $$;

-- Expect an error whose message starts with the code word; the subtransaction
-- rolls back, and the caller checks that nothing was written.
CREATE FUNCTION pg_temp.expect_error(p_sql text, p_code text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE p_code || '%' THEN
      RAISE EXCEPTION 'expected % from [%], got [%] (%)', p_code, p_sql, SQLERRM, SQLSTATE;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'expected % from [%], but it succeeded', p_code, p_sql;
END $$;

CREATE TEMP TABLE before_snap AS SELECT * FROM pg_temp.legacy_snapshot();
CREATE TEMP TABLE before_counts AS
  SELECT (SELECT count(*) FROM public.tenants) AS tenants, (SELECT count(*) FROM public.tenant_settings) AS settings,
         (SELECT count(*) FROM public.notification_type_controls) AS ntc, (SELECT count(*) FROM public.tenant_invitations) AS inv,
         (SELECT count(*) FROM public.chat_groups) AS groups;

-- ── migration 1: backfill + reserved slugs + access ──────────────────────
DO $$ DECLARE s record; BEGIN
  SELECT * INTO s FROM public.tenant_settings WHERE tenant_id = (SELECT maxina FROM k);
  ASSERT s.display_name = 'Maxina' AND s.brand = '{"colors":{"accent":"#FF7BAC","bg":"#FFF5F8","fg":"#1A1A1A"}}'::jsonb, 'maxina brand backfill';
  ASSERT s.legal_entity_line = 'Exafy LTD' AND s.support_email = 'support@vitanaland.com', 'maxina legal/support backfill';
  ASSERT s.sender_name = 'Maxina by VITANA' AND s.sender_email = 'noreply@vitanaland.com', 'maxina sender backfill';
  ASSERT s.persona_facts = '{"community_name":"Maxina","community_pronunciation":"mah-KSEE-nah"}'::jsonb, 'maxina persona backfill';
  ASSERT s.default_locale = 'de' AND cardinality(s.enabled_locales) = 11 AND s.timezone = 'Europe/Berlin' AND s.currency = 'EUR', 'maxina defaults';
  ASSERT s.provisioned_at IS NULL, 'maxina stays legacy';
  ASSERT s.branding = '{"brand_bg":"#FFF5F8","brand_fg":"#1a1a2e","brand_accent":"#FF7BAC"}'::jsonb, 'existing branding untouched';
  ASSERT (s.feature_flags #>> '{jev,monthly_budget_usd}') = '50', 'existing feature_flags untouched';
  SELECT * INTO s FROM public.tenant_settings WHERE tenant_id = (SELECT alkalma FROM k);
  ASSERT s.display_name = 'AlKalma' AND s.brand = '{"colors":{"accent":"#3B82F6","bg":"#EFF6FF","fg":"#1A1A1A"}}'::jsonb, 'alkalma backfill';
  ASSERT s.support_email IS NULL AND s.sender_email IS NULL AND s.sender_name IS NULL, 'alkalma has no sender/support';
  ASSERT s.persona_facts = '{"community_name":"Alkalma"}'::jsonb AND s.legal_entity_line = 'Exafy LTD', 'alkalma persona/legal';
  ASSERT (SELECT count(*) FROM public.tenant_settings WHERE provisioned_at IS NOT NULL) = 0, 'no provisioned rows after migrations';
  ASSERT (SELECT count(*) FROM public.reserved_tenant_slugs) > 100, 'reserved slugs seeded';
  ASSERT (SELECT count(*) FROM public.reserved_tenant_slugs WHERE slug IN ('maxina','alkalma','earthlinks','admin','u','api')) = 6, 'legacy + route + platform slugs reserved';
  ASSERT NOT has_table_privilege('anon', 'public.reserved_tenant_slugs', 'SELECT')
     AND NOT has_table_privilege('authenticated', 'public.reserved_tenant_slugs', 'SELECT'), 'reserved slugs: service_role only';
  ASSERT NOT has_function_privilege('anon', 'public.tenant_settings_merge_feature_flags(uuid,jsonb,boolean,uuid)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.tenant_settings_merge_feature_flags(uuid,jsonb,boolean,uuid)', 'EXECUTE')
     AND has_function_privilege('service_role', 'public.tenant_settings_merge_feature_flags(uuid,jsonb,boolean,uuid)', 'EXECUTE'), 'merge fn: service_role only';
  RAISE NOTICE 'ok: migration 1 backfill, reserved slugs, grants';
END $$;

-- ── provision_tenant access ───────────────────────────────────────────────
DO $$ DECLARE fn text := 'public.provision_tenant(text,text,text,uuid,text,text,numeric,text,text[],text,text)'; BEGIN
  ASSERT NOT has_function_privilege('anon', fn, 'EXECUTE'), 'anon cannot execute provision_tenant';
  ASSERT NOT has_function_privilege('authenticated', fn, 'EXECUTE'), 'authenticated cannot execute provision_tenant';
  ASSERT has_function_privilege('service_role', fn, 'EXECUTE'), 'service_role can execute provision_tenant';
  ASSERT (SELECT prosecdef FROM pg_proc WHERE oid = fn::regprocedure), 'provision_tenant is SECURITY DEFINER';
  ASSERT (SELECT proconfig FROM pg_proc WHERE oid = fn::regprocedure) = ARRAY['search_path=public'], 'search_path pinned';
END $$;
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.provision_tenant('nope', 'Nope', 'a@b.io', (SELECT exafy FROM k), 'All');
  RAISE EXCEPTION 'authenticated could call provision_tenant';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: authenticated EXECUTE denied';
END $$;
RESET ROLE;
SET ROLE anon;
DO $$ BEGIN
  PERFORM public.provision_tenant('nope', 'Nope', 'a@b.io', (SELECT exafy FROM k), 'All');
  RAISE EXCEPTION 'anon could call provision_tenant';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: anon EXECUTE denied';
END $$;
RESET ROLE;

-- ── refusals: zero writes ────────────────────────────────────────────────
DO $$ DECLARE e text := (SELECT exafy FROM k)::text; BEGIN
  PERFORM pg_temp.expect_error(format('SELECT public.provision_tenant(%L,%L,%L,%L::uuid,%L)', s, 'X Co', 'admin@x.io', e, 'All'), code)
    FROM (VALUES ('maxina','RESERVED_SLUG'), ('alkalma','RESERVED_SLUG'), ('admin','RESERVED_SLUG'), ('earthlinks','RESERVED_SLUG'),
                 ('u','INVALID_SLUG'), ('Maxina','INVALID_SLUG'), ('a','INVALID_SLUG'), ('x--y','INVALID_SLUG'), ('-x','INVALID_SLUG'),
                 ('ab','INVALID_SLUG'), ('abcdefghijklmnopqrstuvwxyzabcdefg','INVALID_SLUG'), ('9lives','INVALID_SLUG'),
                 ('handmade','SLUG_TAKEN')) AS v(s, code);
  PERFORM pg_temp.expect_error(format('SELECT public.provision_tenant(%L,%L,%L,%L::uuid,%L)', 'newco', 'New Co', 'admin@x.io', (SELECT plain FROM k), 'All'), 'NOT_EXAFY_ADMIN');
  PERFORM pg_temp.expect_error(format('SELECT public.provision_tenant(%L,%L,%L,%L::uuid,%L)', 'newco', 'New Co', 'admin@x.io', gen_random_uuid(), 'All'), 'NOT_EXAFY_ADMIN');
  PERFORM pg_temp.expect_error(format('SELECT public.provision_tenant(%L,%L,%L,%L::uuid,%L)', 'newco', 'New Co', 'Service-Bot@example.com', e, 'All'), 'SERVICE_ACCOUNT_EMAIL');
  PERFORM pg_temp.expect_error(format('SELECT public.provision_tenant(%L,%L,%L,%L::uuid,%L)', 'newco', 'New Co', 'test-actor@example.com', e, 'All'), 'SERVICE_ACCOUNT_EMAIL');
  PERFORM pg_temp.expect_error(format('SELECT public.provision_tenant(%L,%L,%L,%L::uuid,%L)', 'newco', 'New Co', 'e2e-test@vitana.dev', e, 'All'), 'SERVICE_ACCOUNT_EMAIL');
  PERFORM pg_temp.expect_error(format('SELECT public.provision_tenant(%L,%L,%L,%L::uuid,%L)', 'newco', 'New Co', 'not-an-email', e, 'All'), 'INVALID_ADMIN_EMAIL');
  PERFORM pg_temp.expect_error(format('SELECT public.provision_tenant(%L,%L,%L,%L::uuid,%L)', 'newco', '', 'admin@x.io', e, 'All'), 'INVALID_NAME');
  PERFORM pg_temp.expect_error(format('SELECT public.provision_tenant(%L,%L,%L,%L::uuid,%L)', 'newco', 'New Co', 'admin@x.io', e, ''), 'INVALID_NAME');
  PERFORM pg_temp.expect_error(format('SELECT public.provision_tenant(%L,%L,%L,%L::uuid,%L,p_jev_monthly_budget_usd=>501)', 'newco', 'New Co', 'admin@x.io', e, 'All'), 'INVALID_PARAMS');
  PERFORM pg_temp.expect_error(format('SELECT public.provision_tenant(%L,%L,%L,%L::uuid,%L,p_timezone=>%L)', 'newco', 'New Co', 'admin@x.io', e, 'All', 'Mars/Olympus'), 'INVALID_TIMEZONE');
  PERFORM pg_temp.expect_error(format('SELECT public.provision_tenant(%L,%L,%L,%L::uuid,%L,p_enabled_locales=>%L::text[],p_default_locale=>%L)', 'newco', 'New Co', 'admin@x.io', e, 'All', '{de,xx}', 'de'), 'INVALID_LOCALE');
  PERFORM pg_temp.expect_error(format('SELECT public.provision_tenant(%L,%L,%L,%L::uuid,%L,p_currency=>%L)', 'newco', 'New Co', 'admin@x.io', e, 'All', 'eur'), 'new row for relation');
  RAISE NOTICE 'ok: every refusal raised its code word';
END $$;
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM public.tenants) = (SELECT tenants FROM before_counts), 'refusals created no tenant';
  ASSERT (SELECT count(*) FROM public.tenant_settings) = (SELECT settings FROM before_counts), 'refusals created no settings';
  ASSERT (SELECT count(*) FROM public.notification_type_controls) = (SELECT ntc FROM before_counts), 'refusals created no controls';
  ASSERT (SELECT count(*) FROM public.tenant_invitations) = (SELECT inv FROM before_counts), 'refusals created no invitation';
  ASSERT (SELECT count(*) FROM public.chat_groups) = (SELECT groups FROM before_counts), 'refusals created no group';
  RAISE NOTICE 'ok: refusals wrote nothing';
END $$;

-- ── create ───────────────────────────────────────────────────────────────
SET ROLE service_role;
CREATE TEMP TABLE r1 AS SELECT public.provision_tenant('wellcircle', 'Well Circle', ' Admin@WellCircle.io ',
  (SELECT exafy FROM k), 'Alle zusammen', p_display_name => 'Well Circle', p_jev_monthly_budget_usd => 25) AS j;
RESET ROLE;
DO $$ DECLARE r jsonb := (SELECT j FROM r1); tid uuid := ((SELECT j FROM r1) ->> 'tenant_id')::uuid; s record; g record; BEGIN
  ASSERT (r ->> 'created')::boolean, 'created:true on first call';
  ASSERT r ->> 'slug' = 'wellcircle', 'slug echoed';
  ASSERT (SELECT count(*) FROM public.tenants WHERE slug = 'wellcircle') = 1, '1 tenant';
  ASSERT (SELECT open_signup = false AND is_active AND NOT is_default AND NOT is_platform FROM public.tenants WHERE tenant_id = tid), 'invite-only, active, not default/platform';
  SELECT * INTO s FROM public.tenant_settings WHERE tenant_id = tid;
  ASSERT s.provisioned_at IS NOT NULL AND s.provisioned_by = (SELECT exafy FROM k), 'settings provisioned_at/by';
  ASSERT s.display_name = 'Well Circle' AND s.timezone = 'Europe/Berlin' AND s.currency = 'EUR' AND s.default_locale = 'de', 'settings pack params';
  ASSERT s.feature_flags = '{"jev":{"enabled":true,"planes":["internal","system_autopilot","member"],"monthly_budget_usd":25}}'::jsonb, 'jev flag (Alkalma pattern, budget param)';
  -- notification baseline = the 16 types every legacy tenant holds; maxina's local rows excluded; bool_or
  ASSERT (SELECT count(*) FROM public.notification_type_controls WHERE tenant_id = tid) = 16, '16 baseline controls';
  ASSERT (SELECT count(*) FROM public.notification_type_controls WHERE tenant_id = tid AND enabled) = 16, 'all baseline controls ON (bool_or)';
  ASSERT NOT EXISTS (SELECT 1 FROM public.notification_type_controls WHERE tenant_id = tid AND type LIKE 'live_room%'), 'maxina-local rows excluded';
  ASSERT (SELECT count(*) FROM (SELECT type, source_key FROM public.notification_type_controls WHERE tenant_id = tid
          EXCEPT SELECT type, source_key FROM public.notification_type_controls WHERE tenant_id = (SELECT alkalma FROM k)) d) = 0, 'baseline == alkalma set';
  ASSERT (SELECT count(*) FROM public.ai_provider_policies WHERE tenant_id = tid) = 2, '2 ai policies';
  ASSERT NOT EXISTS (
    SELECT provider, allowed, allowed_models, cost_cap_usd_month, allowed_memory_categories FROM public.ai_provider_policies WHERE tenant_id = tid
    EXCEPT SELECT provider, allowed, allowed_models, cost_cap_usd_month, allowed_memory_categories FROM public.ai_provider_policies WHERE tenant_id = (SELECT maxina FROM k)), 'policies copied from the default tenant';
  ASSERT (SELECT count(*) FROM public.tenant_autopilot_settings WHERE tenant_id = tid AND enabled AND max_recommendations_per_day = 20) = 1, 'autopilot row with defaults';
  SELECT * INTO g FROM public.chat_groups WHERE tenant_id = tid;
  ASSERT g.is_system AND g.name = 'Alle zusammen' AND g.description IS NULL AND g.metadata = '{"cap":null,"seeded_by":"provision_tenant"}'::jsonb, 'system group';
  ASSERT (SELECT count(*) FROM public.chat_groups WHERE tenant_id = tid) = 1, '1 group';
  ASSERT (SELECT count(*) FROM public.chat_group_members WHERE group_id = g.id) = 1
     AND (SELECT role FROM public.chat_group_members WHERE group_id = g.id AND user_id = '00000000-0000-0000-0000-000000000001') = 'bot', 'bot is the only member';
  ASSERT (SELECT count(*) FROM public.tenant_invitations WHERE tenant_id = tid) = 1, '1 invitation';
  ASSERT (SELECT email = 'admin@wellcircle.io' AND roles = ARRAY['admin'] AND invited_by = (SELECT exafy FROM k) AND accepted_at IS NULL
            FROM public.tenant_invitations WHERE tenant_id = tid), 'invitation: lower-cased email, admin role';
  ASSERT (r #>> '{invitation,reused}')::boolean = false AND length(r #>> '{invitation,token}') = 64, 'fresh invitation returned';
  ASSERT r -> 'ensured' = '{"notification_controls":16,"ai_policies":2,"autopilot_settings":1,"system_group":1}'::jsonb, 'ensured counts';
  RAISE NOTICE 'ok: create — 1 tenant, settings, 16 controls, 2 policies, autopilot, group + bot, 1 invitation';
END $$;

-- ── re-run: idempotent, same invitation ───────────────────────────────────
SET ROLE service_role;
CREATE TEMP TABLE r2 AS SELECT public.provision_tenant('wellcircle', 'Well Circle', 'admin@wellcircle.io',
  (SELECT exafy FROM k), 'Alle zusammen') AS j;
RESET ROLE;
DO $$ DECLARE a jsonb := (SELECT j FROM r1); b jsonb := (SELECT j FROM r2); tid uuid := ((SELECT j FROM r1) ->> 'tenant_id')::uuid; BEGIN
  ASSERT (b ->> 'created')::boolean = false, 'created:false on re-run';
  ASSERT b ->> 'tenant_id' = a ->> 'tenant_id', 'same tenant';
  ASSERT b #>> '{invitation,id}' = a #>> '{invitation,id}' AND (b #>> '{invitation,reused}')::boolean, 'same invitation reused';
  ASSERT (SELECT count(*) FROM public.tenants WHERE slug = 'wellcircle') = 1
     AND (SELECT count(*) FROM public.notification_type_controls WHERE tenant_id = tid) = 16
     AND (SELECT count(*) FROM public.ai_provider_policies WHERE tenant_id = tid) = 2
     AND (SELECT count(*) FROM public.tenant_autopilot_settings WHERE tenant_id = tid) = 1
     AND (SELECT count(*) FROM public.chat_groups WHERE tenant_id = tid) = 1
     AND (SELECT count(*) FROM public.chat_group_members WHERE tenant_id = tid) = 1
     AND (SELECT count(*) FROM public.tenant_invitations WHERE tenant_id = tid) = 1, 'no duplicate rows';
  ASSERT (SELECT feature_flags #>> '{jev,monthly_budget_usd}' FROM public.tenant_settings WHERE tenant_id = tid) = '25', 're-run does not rewrite settings';
  PERFORM pg_temp.expect_error(format('SELECT public.provision_tenant(%L,%L,%L,%L::uuid,%L)', 'wellcircle', 'Other Name', 'admin@wellcircle.io', (SELECT exafy FROM k), 'All'), 'SLUG_TAKEN');
  RAISE NOTICE 'ok: re-run — created:false, same tenant, same invitation, no duplicates; other name → SLUG_TAKEN';
END $$;

-- ── Maxina / Alkalma unchanged ────────────────────────────────────────────
DO $$ BEGIN
  ASSERT NOT EXISTS (SELECT * FROM before_snap EXCEPT SELECT * FROM pg_temp.legacy_snapshot())
     AND NOT EXISTS (SELECT * FROM pg_temp.legacy_snapshot() EXCEPT SELECT * FROM before_snap),
    'legacy tenants rows (tenants, settings, controls, policies, autopilot, groups, members, invitations) and member-facing tables unchanged';
  ASSERT (SELECT count(*) FROM public.user_tenants) = 0 AND (SELECT count(*) FROM public.memberships) = 0
     AND (SELECT count(*) FROM public.app_users) = 0 AND (SELECT count(*) FROM public.chat_messages) = 0
     AND (SELECT count(*) FROM public.user_notifications) = 0 AND (SELECT count(*) FROM public.founding_members) = 0, 'zero member-facing rows';
  RAISE NOTICE 'ok: maxina/alkalma unchanged (md5 of every row), zero member-facing writes';
END $$;

-- ── brand-pack validation trigger ─────────────────────────────────────────
DO $$ DECLARE tid text := (SELECT j ->> 'tenant_id' FROM r1); BEGIN
  PERFORM pg_temp.expect_error(format('UPDATE public.tenant_settings SET timezone = %L WHERE tenant_id = %L', 'Europe/Nowhere', tid), 'INVALID_TIMEZONE');
  PERFORM pg_temp.expect_error(format('UPDATE public.tenant_settings SET enabled_locales = %L WHERE tenant_id = %L', '{de,klingon}', tid), 'INVALID_LOCALE');
  PERFORM pg_temp.expect_error(format('UPDATE public.tenant_settings SET brand = %L WHERE tenant_id = %L', '{"logo_path":"maxina/logo.png"}', tid), 'INVALID_ASSET_PATH');
  PERFORM pg_temp.expect_error(format('UPDATE public.tenant_settings SET brand = %L WHERE tenant_id = %L', '{"logo_path":"wellcircle/../maxina/logo.png"}', tid), 'INVALID_ASSET_PATH');
  PERFORM pg_temp.expect_error(format('UPDATE public.tenant_settings SET landing = %L WHERE tenant_id = %L', '{"hero_image_path":"other/hero.jpg"}', tid), 'INVALID_ASSET_PATH');
  PERFORM pg_temp.expect_error(format('UPDATE public.tenant_settings SET brand = %L WHERE tenant_id = %L', '{"logo_path":42}', tid), 'INVALID_ASSET_PATH');
  PERFORM pg_temp.expect_error(format('UPDATE public.tenant_settings SET support_email = %L WHERE tenant_id = %L', 'nope', tid), 'new row for relation');
  PERFORM pg_temp.expect_error(format('UPDATE public.tenant_settings SET enabled_locales = %L WHERE tenant_id = %L', '{en}', tid), 'new row for relation');
  EXECUTE format('UPDATE public.tenant_settings SET brand = %L, landing = %L WHERE tenant_id = %L',
    '{"colors":{"accent":"#000000","bg":"#FFFFFF","fg":"#111111"},"logo_path":"wellcircle/logo.png"}', '{"hero_image_path":"wellcircle/hero.webp","cta":"invite_only"}', tid);
  RAISE NOTICE 'ok: trigger rejects bad timezone, unknown locale, foreign/.. paths; accepts paths under <slug>/';
END $$;

-- The tenant-admin PUT (an upsert of profile/branding) still works on a legacy row.
SET ROLE service_role;
INSERT INTO public.tenant_settings AS s (tenant_id, profile, branding, updated_at)
VALUES ((SELECT alkalma FROM k), '{"name":"Alkalma"}', '{"brand_accent":"#3B82F6"}', now())
ON CONFLICT (tenant_id) DO UPDATE SET profile = EXCLUDED.profile, branding = EXCLUDED.branding, updated_at = EXCLUDED.updated_at;
RESET ROLE;
DO $$ BEGIN
  ASSERT (SELECT profile ->> 'name' FROM public.tenant_settings WHERE tenant_id = (SELECT alkalma FROM k)) = 'Alkalma', 'legacy upsert landed';
  ASSERT (SELECT display_name FROM public.tenant_settings WHERE tenant_id = (SELECT alkalma FROM k)) = 'AlKalma', 'legacy upsert kept the brand pack';
  RAISE NOTICE 'ok: tenant-admin style upsert of profile/branding still succeeds on a legacy row';
END $$;

-- ── feature_flags merge (tenant-admin PUT) ─────────────────────────────────
SET ROLE service_role;
SELECT public.tenant_settings_merge_feature_flags((SELECT alkalma FROM k),
  '{"jev":{"enabled":true,"planes":["internal"],"monthly_budget_usd":9999},"enable_voice_widget":true}', false, (SELECT plain FROM k));
RESET ROLE;
DO $$ DECLARE f jsonb := (SELECT feature_flags FROM public.tenant_settings WHERE tenant_id = (SELECT alkalma FROM k)); BEGIN
  ASSERT f -> 'jev' = '{"planes":["internal","system_autopilot","member"],"enabled":true,"monthly_budget_usd":10}'::jsonb, 'tenant admin cannot change jev';
  ASSERT (f ->> 'enable_voice_widget')::boolean, 'other keys merged';
END $$;
SET ROLE service_role;
SELECT public.tenant_settings_merge_feature_flags((SELECT alkalma FROM k), '{"jev":{"enabled":true,"planes":["internal"],"monthly_budget_usd":20}}', true, (SELECT exafy FROM k));
RESET ROLE;
DO $$ DECLARE f jsonb := (SELECT feature_flags FROM public.tenant_settings WHERE tenant_id = (SELECT alkalma FROM k)); BEGIN
  ASSERT (f #>> '{jev,monthly_budget_usd}') = '20', 'exafy_admin can change jev';
  ASSERT (f ->> 'enable_voice_widget')::boolean, 'merge keeps keys the caller did not send';
  RAISE NOTICE 'ok: feature_flags merge keeps jev for tenant admins, exafy_admin may change it';
END $$;

-- ── a newly migrated CROSS JOIN type is picked up without editing the function ─
INSERT INTO public.notification_type_controls (tenant_id, type, enabled, reason)
SELECT tenant_id, 'brand_new_type', true, 'fixture: a later type migration' FROM public.tenants
ON CONFLICT DO NOTHING;
SET ROLE service_role;
CREATE TEMP TABLE r3 AS SELECT public.provision_tenant('second-co', 'Second Co', 'owner@second.io', (SELECT exafy FROM k), 'Everyone') AS j;
RESET ROLE;
DO $$ DECLARE tid uuid := ((SELECT j FROM r3) ->> 'tenant_id')::uuid; BEGIN
  ASSERT (SELECT count(*) FROM public.notification_type_controls WHERE tenant_id = tid) = 17, 'baseline grew to 17';
  ASSERT EXISTS (SELECT 1 FROM public.notification_type_controls WHERE tenant_id = tid AND type = 'brand_new_type' AND enabled), 'new CROSS JOIN type picked up';
  RAISE NOTICE 'ok: a new CROSS JOIN type is in the computed baseline';
END $$;

-- ── no default tenant → NO_DEFAULT_TENANT, nothing written ───────────────
BEGIN;
-- Lane A's one-default trigger is deferred to COMMIT; this probe rolls back first.
UPDATE public.tenants SET is_default = false;
SELECT pg_temp.expect_error($q$SELECT public.provision_tenant('third-co', 'Third Co', 'owner@third.io', 'a0000000-0000-4000-8000-000000000001', 'All')$q$, 'NO_DEFAULT_TENANT');
DO $$ BEGIN ASSERT NOT EXISTS (SELECT 1 FROM public.tenants WHERE slug = 'third-co'), 'nothing written without a default tenant'; END $$;
ROLLBACK;
DO $$ BEGIN RAISE NOTICE 'ok: no default tenant → NO_DEFAULT_TENANT, nothing written'; END $$;

\echo 'VTID-05150: all assertions passed'
