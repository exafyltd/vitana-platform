-- VTID-05575 (mt-network-r2/matching-intent-scope-db) - pgTAP: daily_matches.scope + tenant context + backfill (D15),
-- the health-derived match_reasons guard (D25), the network candidate rule (network_visible, rules 43-45), and the
-- scope-aware intent matchers (search_intent_catalog(_v2), compute_intent_matches(_v2)).
-- Runs on a throwaway Postgres after docs/validation/VTID-05575/pgtap/vtid_05575_fixture.sql, the VTID-05582 migration
-- 20261102051000 and the three lane migrations 20261102053000/053100/053200. One transaction, rolled back at the end: never
-- a shared or live database. The file inserts its own rows and asserts no absolute table counts.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(59);

CREATE SCHEMA t05575;
GRANT USAGE ON SCHEMA t05575 TO authenticated, anon, service_role;

CREATE FUNCTION t05575.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('05575000-0000-4000-8000-00000000' || lpad(n::text, 4, '0'))::uuid $$;
CREATE FUNCTION t05575.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '05575000-0000-4000-8000-0000000000a1'::uuid $$;
CREATE FUNCTION t05575.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '05575000-0000-4000-8000-0000000000a2'::uuid $$;
CREATE FUNCTION t05575.tp() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '05575000-0000-4000-8000-0000000000a3'::uuid $$;
CREATE FUNCTION t05575.d(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('05575000-0000-4000-8000-0000000000d' || n::text)::uuid $$;
CREATE FUNCTION t05575.i(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('05575000-0000-4000-8000-0000000001a' || n::text)::uuid $$;

-- First column of the first row of p_sql run as role p_role with auth.uid() = p_uid ('error:<SQLSTATE>' on failure).
CREATE FUNCTION t05575.val(p_role text, p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims',
    (jsonb_build_object('role', p_role) || CASE WHEN p_uid IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sub', p_uid) END)::text, true);
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
-- 'ok' or 'error:<SQLSTATE>' for a statement run as the session owner (a trusted writer).
CREATE FUNCTION t05575.try(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_sql; EXCEPTION WHEN OTHERS THEN RETURN 'error:' || SQLSTATE; END;
  RETURN 'ok';
END $$;
CREATE FUNCTION t05575.ins(p_from int, p_to int, p_scope text, p_tenant uuid, p_reasons text DEFAULT '[]') RETURNS text LANGUAGE sql AS $$
  SELECT t05575.try(format('INSERT INTO public.daily_matches (user_id, matched_user_id, match_score, match_reasons, scope, tenant_id)
    VALUES (%L, %L, 50, %L::jsonb, %L, %L)', t05575.u(p_from), t05575.u(p_to), p_reasons, p_scope, p_tenant)) $$;
-- The candidate users (last 4 digits of the id) a search returns, e.g. '2,3,8'. p_scope NULL = the parameter is omitted.
CREATE FUNCTION t05575.pool(p_fn text, p_viewer int, p_scope text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  EXECUTE format('SELECT string_agg(right(cand_user_id::text, 1), '','' ORDER BY cand_user_id) FROM public.%I(%L::uuid, %L::uuid, %L, NULL, %L::jsonb, p_top_n => 50%s)',
    p_fn, t05575.u(p_viewer), t05575.ta(), 'activity_seek', '{}',
    CASE WHEN p_scope IS NULL THEN '' ELSE format(', p_visibility => %L', p_scope) END)
  INTO v;
  RETURN v;
END $$;
-- The intents (last char of the intent id) a compute_* call matched intent 1 with.
CREATE FUNCTION t05575.matched(p_fn text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  DELETE FROM public.intent_matches WHERE intent_a_id = t05575.i(1);
  EXECUTE format('SELECT public.%I(%L::uuid, 50)', p_fn, t05575.i(1));
  SELECT string_agg(right(intent_b_id::text, 1), ',' ORDER BY intent_b_id) INTO v FROM public.intent_matches WHERE intent_a_id = t05575.i(1);
  RETURN v;
END $$;
GRANT EXECUTE ON FUNCTION t05575.u(int), t05575.ta(), t05575.tb(), t05575.tp(), t05575.d(int), t05575.i(int),
  t05575.val(text, uuid, text), t05575.try(text), t05575.ins(int, int, text, uuid, text),
  t05575.pool(text, int, text), t05575.matched(text) TO authenticated, anon, service_role;

-- ── A. Columns ───────────────────────────────────────────────────────────
SELECT ok(EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'daily_matches'
  AND column_name = 'scope' AND data_type = 'text' AND is_nullable = 'NO' AND column_default LIKE '''community''%'),
  '1 daily_matches.scope text NOT NULL DEFAULT community');
SELECT ok(EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'daily_matches'
  AND column_name = 'tenant_id' AND data_type = 'uuid' AND is_nullable = 'YES'), '2 daily_matches.tenant_id uuid is nullable (tenant context)');
SELECT is(t05575.ins(1, 2, 'public', NULL), 'error:23514', '3 scope CHECK rejects a value other than community / network');
SELECT is((SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'public.daily_matches'::regclass AND contype IN ('p', 'u')), 1,
  '4 no unique key was added: the primary key is the only one');
SELECT ok(EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'daily_matches' AND indexname = 'idx_daily_matches_scope_tenant'),
  '5 index on (scope, tenant_id)');

-- ── B. Backfill per D15 (shared non-platform tenant -> community of it, else network) ─────────────
SELECT is((SELECT scope || '/' || coalesce(tenant_id::text, '-') FROM public.daily_matches WHERE id = t05575.d(1)), 'community/' || t05575.ta(),
  '6 U1 -> U2 share TA: community, tenant TA');
SELECT is((SELECT scope || '/' || coalesce(tenant_id::text, '-') FROM public.daily_matches WHERE id = t05575.d(2)), 'network/-',
  '7 U1 -> U3 share nothing: network, no tenant');
SELECT is((SELECT scope || '/' || coalesce(tenant_id::text, '-') FROM public.daily_matches WHERE id = t05575.d(3)), 'community/' || t05575.tb(),
  '8 U3 -> U4 share TB only: community, tenant TB');
SELECT is((SELECT scope || '/' || coalesce(tenant_id::text, '-') FROM public.daily_matches WHERE id = t05575.d(4)), 'community/' || t05575.ta(),
  '9 U4 -> U2 share TA (U4 is also in TB): community, tenant TA (the viewer''s primary)');
SELECT is((SELECT scope || '/' || coalesce(tenant_id::text, '-') FROM public.daily_matches WHERE id = t05575.d(5)), 'network/-',
  '10 U1 -> U7 share only the platform tenant: network (the platform tenant does not count)');

-- ── C. No health-derived match reason (D25) ──────────────────────────────
SELECT is((SELECT match_reasons FROM public.daily_matches WHERE id = t05575.d(1)), '[{"code":"mutual_connections","params":{"count":2}}]'::jsonb,
  '11 backfill removed shared_pillar and similar_index, kept the rest');
SELECT is((SELECT match_reasons FROM public.daily_matches WHERE id = t05575.d(2)), '[{"code":"active_member"}]'::jsonb,
  '12 a row left with no reason gets the honest fallback active_member');
SELECT is((SELECT match_reasons FROM public.daily_matches WHERE id = t05575.d(3)), '[{"code":"active_member"}]'::jsonb, '13 a clean row is untouched');
SELECT is((SELECT match_reasons FROM public.daily_matches WHERE id = t05575.d(4)), '["Same location: Berlin"]'::jsonb,
  '14 legacy string reasons: the health one is dropped, the other kept');
SELECT is((SELECT match_reasons FROM public.daily_matches WHERE id = t05575.d(5)), '[{"code":"same_location","params":{"location":"Pillar Street"}}]'::jsonb,
  '15 only the code decides: a parameter that merely says Pillar is kept');
SELECT is(public.strip_health_match_reasons('[{"code":"pillar_balance"},{"code":"vitana_index_gap"},{"code":"health_goal_overlap"},{"code":"same_location"}]'::jsonb),
  '[{"code":"same_location"}]'::jsonb, '16 strip_health_match_reasons drops every code that names the index, a pillar or health');
SELECT is(public.strip_health_match_reasons(NULL), '[{"code":"active_member"}]'::jsonb, '17 NULL becomes the fallback');
SELECT is(public.strip_health_match_reasons('{"code":"similar_index"}'::jsonb), '[{"code":"active_member"}]'::jsonb, '18 a non-array becomes the fallback');
SELECT is(t05575.ins(2, 1, 'community', NULL, '[{"code":"shared_pillar"},{"code":"mutual_connections"}]'), 'ok', '19a a trusted writer inserts a row with a health reason');
SELECT is((SELECT match_reasons FROM public.daily_matches WHERE user_id = t05575.u(2) AND matched_user_id = t05575.u(1) AND match_score = 50),
  '[{"code":"mutual_connections"}]'::jsonb, '19 the trigger strips it on INSERT');
SELECT is(t05575.try(format('UPDATE public.daily_matches SET match_reasons = %L::jsonb WHERE user_id = %L AND matched_user_id = %L',
  '[{"code":"similar_index"},{"code":"same_location"}]', t05575.u(2), t05575.u(1))), 'ok', '20a a trusted writer rewrites the reasons');
SELECT is((SELECT match_reasons FROM public.daily_matches WHERE user_id = t05575.u(2) AND matched_user_id = t05575.u(1) AND match_score = 50),
  '[{"code":"same_location"}]'::jsonb, '20 the trigger strips it on UPDATE');
SELECT is((SELECT count(*)::int FROM public.daily_matches WHERE user_id IN (SELECT t05575.u(g) FROM generate_series(1, 8) g)
  AND match_reasons::text ~ '(shared_pillar|similar_index)'), 0, '21 no row of the fixture members carries a health reason code');

-- ── D. A member can mark a match, never move or rewrite it ───────────────
SELECT is(t05575.val('authenticated', t05575.u(1), format($q$WITH u AS (UPDATE public.daily_matches SET action = 'connect', scope = 'network',
    tenant_id = NULL, match_reasons = '[{"code":"similar_index"}]' WHERE id = %L RETURNING scope, action, match_reasons)
  SELECT scope || '/' || action || '/' || (match_reasons -> 0 ->> 'code') FROM u$q$, t05575.d(1))), 'community/connect/mutual_connections',
  '22 a member update keeps the action but cannot change scope, tenant or reasons');
SELECT is(t05575.val('authenticated', t05575.u(1), format('WITH u AS (UPDATE public.daily_matches SET matched_user_id = %L WHERE id = %L RETURNING matched_user_id) SELECT matched_user_id::text FROM u',
  t05575.u(3), t05575.d(1))), t05575.u(2)::text, '23 a member cannot repoint a match at another user');

-- ── E. Network and community write guards ────────────────────────────────
SELECT is(t05575.ins(1, 3, 'network', NULL), 'error:42501', '24 a network row for a member who has not opted in is refused');
UPDATE public.global_community_profiles SET network_visible = true WHERE user_id IN (t05575.u(3), t05575.u(5), t05575.u(6));
SELECT is(t05575.ins(1, 3, 'network', NULL), 'ok', '25 once the member has opted in the network row is accepted');
SELECT is(t05575.ins(1, 5, 'network', NULL), 'error:42501', '26 a service bot is never a network candidate (rule 43)');
SELECT is(t05575.ins(1, 6, 'network', NULL), 'error:42501', '27 a notification test actor is never a network candidate (rule 43)');
UPDATE public.global_community_profiles SET network_visible = true WHERE user_id = t05575.u(4);
INSERT INTO public.service_bot_accounts (user_id) VALUES (t05575.u(4));
SELECT is(t05575.ins(1, 4, 'network', NULL), 'error:42501', '28 an account registered AFTER it opted in is refused at write time (rule 44 residual)');
DELETE FROM public.service_bot_accounts WHERE user_id = t05575.u(4);
SELECT is(t05575.ins(1, 2, 'community', t05575.ta()), 'ok', '29 a community row with a tenant both members belong to is accepted');
SELECT is(t05575.ins(1, 3, 'community', t05575.ta()), 'error:42501', '30 a community row whose tenant the matched user is not in is refused');
SELECT is(t05575.ins(7, 1, 'community', t05575.tp()), 'error:42501', '31 the platform tenant is never community context');
SELECT is(t05575.ins(1, 8, 'community', NULL), 'ok', '32 a community row with no tenant is accepted (the current writer; the v1 lane fills it later)');
UPDATE public.global_community_profiles SET network_visible = false WHERE user_id = t05575.u(3);
SELECT is(t05575.val('service_role', NULL, format('WITH u AS (UPDATE public.daily_matches SET viewed_at = now() WHERE user_id = %L AND matched_user_id = %L AND scope = ''network'' RETURNING 1) SELECT (count(*) > 0)::text FROM u',
  t05575.u(1), t05575.u(3))), 'true', '33 an unchanged network row is not re-checked: opting out later does not break marking it viewed');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'public.daily_matches'::regclass AND tgname = 'trg_daily_matches_scope_guard'
  AND NOT tgisinternal AND (tgtype & 2) = 2 AND (tgtype & 4) = 4 AND (tgtype & 16) = 16), 1, '34 one BEFORE INSERT OR UPDATE guard trigger');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('daily_matches_scope_guard', 'is_network_candidate', 'intent_pool_allows')
  AND p.prosecdef AND p.proconfig::text LIKE '%search_path%'), 3, '35 the guard and the two helpers are SECURITY DEFINER with a pinned search_path');

-- ── F. Helper grants and results ─────────────────────────────────────────
UPDATE public.global_community_profiles SET network_visible = true WHERE user_id = t05575.u(3);
SELECT is(t05575.val('service_role', NULL, format('SELECT public.is_network_candidate(%L)::text || ''/'' || public.is_network_candidate(%L)::text || ''/'' || public.is_network_candidate(%L)::text || ''/'' || public.is_network_candidate(NULL)::text',
  t05575.u(3), t05575.u(2), t05575.u(5))), 'true/false/false/false', '36 is_network_candidate: opted in = true; not opted in, service bot and NULL = false');
SELECT ok(has_function_privilege('service_role', 'public.is_network_candidate(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.is_network_candidate(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.is_network_candidate(uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.intent_pool_allows(uuid,uuid,uuid,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.intent_pool_allows(uuid,uuid,uuid,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.intent_pool_allows(uuid,uuid,uuid,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.strip_health_match_reasons(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.daily_matches_scope_guard()', 'EXECUTE'),
  '37 the helpers are service_role only: clients cannot probe who is network visible');
SELECT is(public.intent_pool_allows(t05575.tb(), t05575.ta(), t05575.u(3), 'community'), false, '38 community scope: another tenant is out');
SELECT is(public.intent_pool_allows(t05575.ta(), t05575.ta(), t05575.u(2), 'community'), true, '39 community scope: the same tenant is in');

-- ── G. The intent matchers (viewer U1 in TA; U2 and U8 are in TA, U3 and U4 are opted-in network members of TB, U5 is a bot) ─────
SELECT is(t05575.pool('search_intent_catalog_v2', 1, NULL), '2,8', '40 search_intent_catalog_v2 with no scope: community only (the old default was everyone)');
SELECT is(t05575.pool('search_intent_catalog_v2', 1, 'community'), '2,8', '41 explicit community: the same');
SELECT is(t05575.pool('search_intent_catalog_v2', 1, 'network'), '2,3,4,8', '42 network: community plus the opted-in members of other tenants, no service bot');
SELECT is(t05575.pool('search_intent_catalog_v2', 1, 'public'), '2,3,4,8', '43 a legacy explicit public is the network rule, not everyone');
UPDATE public.global_community_profiles SET network_visible = false WHERE user_id = t05575.u(3);
SELECT is(t05575.pool('search_intent_catalog_v2', 1, 'network'), '2,4,8', '44 a member who opts out leaves the network pool at once');
UPDATE public.global_community_profiles SET network_visible = true WHERE user_id = t05575.u(3);
SELECT is(t05575.pool('search_intent_catalog', 1, NULL) || '|' || t05575.pool('search_intent_catalog', 1, 'network'), '2,8|2,3,4,8',
  '45 search_intent_catalog (non-v2) follows the same rule');
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('search_intent_catalog', 'search_intent_catalog_v2')
  AND pg_get_function_arguments(p.oid) LIKE '%p_visibility text DEFAULT ''community''::text%'), 2, '46 the p_visibility default is community on both search functions');
SELECT is(t05575.matched('compute_intent_matches_v2'), '2,3,4,8', '47 compute_intent_matches_v2 for a public intent: tenant members plus opted-in members, never the bot');
UPDATE public.user_intents SET visibility = 'tenant' WHERE intent_id = t05575.i(1);
SELECT is(t05575.matched('compute_intent_matches_v2'), '2,8', '48 a tenant-visibility intent matches inside its tenant only');
UPDATE public.user_intents SET visibility = 'public' WHERE intent_id = t05575.i(1);
SELECT is(t05575.matched('compute_intent_matches'), '2,3,4,8', '49 compute_intent_matches (non-v2) follows the same rule');
SELECT is((SELECT count(*)::int FROM public.intent_matches WHERE intent_b_id = t05575.i(5)), 0, '50 the service bot''s intent is never matched');
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('search_intent_catalog', 'search_intent_catalog_v2', 'compute_intent_matches', 'compute_intent_matches_v2')
  AND p.prosecdef AND p.proconfig::text LIKE '%search_path%'), 4, '51 the four matchers stay SECURITY DEFINER with a pinned search_path');
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('search_intent_catalog', 'search_intent_catalog_v2', 'compute_intent_matches', 'compute_intent_matches_v2')
  AND pg_get_functiondef(p.oid) ~ 'OR (p_visibility|src\.visibility) = ''public''\)'), 0, '52 no matcher keeps the old tenant-or-public pool test');
SELECT ok(has_function_privilege('authenticated', 'public.compute_intent_matches_v2(uuid,integer)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.compute_intent_matches_v2(uuid,integer)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.compute_intent_matches_v2(uuid,integer)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.search_intent_catalog_v2(uuid,uuid,text,text,jsonb,text,text,integer)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.search_intent_catalog_v2(uuid,uuid,text,text,jsonb,text,text,integer)', 'EXECUTE'),
  '53 the matchers keep their grants (CREATE OR REPLACE)');
SELECT is((SELECT count(*)::int FROM public.intent_matches WHERE match_reasons::text ~ '(vitana_index|pillar|health)'), 0,
  '54 intent match reasons carry no Vitana Index or health input');

-- ── H. Policies ──────────────────────────────────────────────────────────
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename = 'daily_matches'), 2,
  '55 daily_matches keeps its two own-row policies; the lane adds none');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename = 'daily_matches'
  AND (coalesce(qual, '') || coalesce(with_check, '')) ~ 'current_tenant_id'), 0, '56 no bare current_tenant_id() policy');
SELECT is((SELECT count(*)::int FROM public.daily_matches WHERE scope NOT IN ('community', 'network') OR scope IS NULL), 0, '57 every row has a valid scope');

SELECT * FROM finish();
ROLLBACK;
