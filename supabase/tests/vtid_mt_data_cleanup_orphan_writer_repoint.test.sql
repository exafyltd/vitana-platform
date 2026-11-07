-- VTID-05571 (mt-data-cleanup-r2 / orphan-analysis-and-quarantine) — pgTAP: the writer repoint (task O8).
-- Runs with `supabase test db` (pg_prove) on the local stack, after every migration including
-- 20261102040400_vtid_05571_writer_repoint.sql. One transaction, rolled back at the end: the writers INSERT, so
-- this never runs against a shared or live database.
--
-- Covers, for every repointed function of 01127 / 01135 / 01137 / 01138 / 01139 / 01144 (19 functions):
--  * a caller with exactly one is_primary row succeeds and writes that tenant;
--  * a caller with no primary row and a caller with two primary rows fail closed and write no row with ...0001;
--  * the five 01127 functions called with a NULL auth.uid() return UNAUTHENTICATED and write no ...0099 row;
--  * no repointed body contains the ...0001 / ...0099 literal (pg_get_functiondef); grants are unchanged;
--  * d45_acknowledge_window returns the JSON TENANT_UNRESOLVED error (no raise) and leaves the window unacknowledged;
--  * the precondition gate RAISEs on a fixture with the column but zero primary rows, on an empty user_tenants while
--    auth.users has accounts, and on a partial backfill; it passes on a fresh stack (both tables empty) and full coverage.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(47);

CREATE TEMP TABLE t05571w_ids (k text PRIMARY KEY, v uuid NOT NULL);
INSERT INTO t05571w_ids VALUES
  ('W1', '05571001-0000-4000-8000-0000000000a1'),  -- exactly one primary (TA)
  ('W0', '05571001-0000-4000-8000-0000000000a2'),  -- membership, no primary row
  ('W2', '05571001-0000-4000-8000-0000000000a3');  -- two primary rows (TA, TB)
CREATE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT v FROM t05571w_ids WHERE k = p $$;

DO $fx$
DECLARE r jsonb;
BEGIN
  INSERT INTO public.tenants (name, slug) VALUES ('VTID-05571 writer tenant A', 'vtid-05571-wa') RETURNING to_jsonb(tenants.*) INTO r;
  INSERT INTO t05571w_ids VALUES ('TA', coalesce(r ->> 'tenant_id', r ->> 'id')::uuid);
  INSERT INTO public.tenants (name, slug) VALUES ('VTID-05571 writer tenant B', 'vtid-05571-wb') RETURNING to_jsonb(tenants.*) INTO r;
  INSERT INTO t05571w_ids VALUES ('TB', coalesce(r ->> 'tenant_id', r ->> 'id')::uuid);
END
$fx$;

SELECT set_config('vitana.suppress_membership_side_effects', 'on', true);
INSERT INTO public.app_users (user_id, email, display_name)
SELECT v, 'vtid05571w-' || lower(k) || '@vitanatest.exafy.io', 'VTID-05571 ' || k FROM t05571w_ids WHERE k LIKE 'W%'
ON CONFLICT (user_id) DO NOTHING;
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES
  (pg_temp.id('TA'), pg_temp.id('W1'), true),
  (pg_temp.id('TA'), pg_temp.id('W0'), false),
  (pg_temp.id('TA'), pg_temp.id('W2'), true),
  (pg_temp.id('TB'), pg_temp.id('W2'), true);

-- Seed parents for W0/W2 under a third tenant value (no FK), so the child writers can be reached and still prove they
-- fail closed on the tenant lookup. These rows sit under TS, outside every assertion about TA/TB/...0001.
INSERT INTO t05571w_ids VALUES ('TS', '05571001-0000-4000-8000-0000000000f0');
INSERT INTO public.d44_predictive_signals (tenant_id, user_id, signal_type, confidence, time_window, detected_change, user_impact, suggested_action, explainability_text, expires_at)
SELECT pg_temp.id('TS'), pg_temp.id(u), 'health_drift', 70, 'last_14_days', 'c', 'medium', 'awareness', 'e', now() + interval '1 day' FROM unnest(ARRAY['W0', 'W2']) u;
INSERT INTO public.d45_predictive_windows (tenant_id, user_id, window_type, domain, time_horizon, start_time, end_time, confidence, severity, recommended_mode, explainability_text)
SELECT pg_temp.id('TS'), pg_temp.id(u), 'risk', 'health', 'short', now(), now() + interval '1 day', 50, 50, 'awareness', 'e' FROM unnest(ARRAY['W0', 'W2']) u;

CREATE FUNCTION pg_temp.jid(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN p LIKE '{%' THEN p::jsonb ->> 'id' END $$;
CREATE FUNCTION pg_temp.jerr(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN p LIKE '{%' THEN p::jsonb ->> 'error' END $$;

-- Calls every repointed function as p_user and records the result. A raise is recorded, not propagated.
CREATE TEMP TABLE t05571w_calls (fn text, usr text, res text, raised text);
CREATE FUNCTION pg_temp.rec(p_fn text, p_usr text, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  BEGIN
    EXECUTE 'SELECT (' || p_sql || ')::text' INTO v;
    INSERT INTO t05571w_calls VALUES (p_fn, p_usr, v, NULL);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO t05571w_calls VALUES (p_fn, p_usr, NULL, SQLSTATE || ': ' || SQLERRM);
  END;
  RETURN v;
END $$;

CREATE FUNCTION pg_temp.run_all(p_usr text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_sig text; v_win text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', pg_temp.id(p_usr)::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(p_usr)::text, 'role', 'authenticated')::text, true);

  PERFORM pg_temp.rec('availability_compute', p_usr, 'public.availability_compute()');
  PERFORM pg_temp.rec('availability_get_override', p_usr, 'public.availability_get_override()');
  PERFORM pg_temp.rec('availability_set_override', p_usr, $q$public.availability_set_override(NULL, 'low', 15, NULL, 'vtid-05571')$q$);
  PERFORM pg_temp.rec('availability_clear_override', p_usr, 'public.availability_clear_override()');
  PERFORM pg_temp.rec('availability_get_recent', p_usr, 'public.availability_get_recent()');

  PERFORM pg_temp.rec('d41_set_personal_boundary', p_usr, $q$public.d41_set_personal_boundary('privacy_level', 'strict', 'vtid-05571')$q$);
  PERFORM pg_temp.rec('d41_set_consent', p_usr, $q$public.d41_set_consent('health_general', 'granted', NULL, 'vtid-05571')$q$);

  PERFORM pg_temp.rec('d43_record_data_point', p_usr, $q$public.d43_record_data_point('engagement', 'k', '{"a":1}'::jsonb)$q$);
  PERFORM pg_temp.rec('d43_create_adaptation_plan', p_usr, $q$public.d43_create_adaptation_plan('{"domains_to_update":"[]"}'::jsonb)$q$);
  PERFORM pg_temp.rec('d43_create_snapshot', p_usr, $q$public.d43_create_snapshot('user_requested')$q$);

  v_sig := pg_temp.rec('d44_create_signal', p_usr,
    $q$public.d44_create_signal('{"signal_type":"health_drift","detected_change":"c","explainability_text":"e"}'::jsonb)$q$);
  v_sig := coalesce(pg_temp.jid(v_sig), (SELECT id::text FROM public.d44_predictive_signals WHERE user_id = pg_temp.id(p_usr) AND tenant_id = pg_temp.id('TS')));
  PERFORM pg_temp.rec('d44_add_signal_evidence', p_usr,
    format($q$public.d44_add_signal_evidence(%L::uuid, '{"evidence_type":"memory","source_ref":"r","source_table":"t","summary":"s"}'::jsonb)$q$, v_sig));
  PERFORM pg_temp.rec('d44_update_signal_status', p_usr,
    format($q$public.d44_update_signal_status(%L::uuid, 'acknowledged', 'f')$q$, v_sig));
  PERFORM pg_temp.rec('d44_record_intervention', p_usr,
    format($q$public.d44_record_intervention(%L::uuid, 'acknowledged')$q$, v_sig));

  v_win := pg_temp.rec('d45_store_window', p_usr,
    $q$public.d45_store_window('{"window_type":"risk","domain":"health","start_time":"2030-01-01T00:00:00Z","end_time":"2030-01-02T00:00:00Z"}'::jsonb)$q$);
  v_win := coalesce(pg_temp.jid(v_win), (SELECT id::text FROM public.d45_predictive_windows WHERE user_id = pg_temp.id(p_usr) AND tenant_id = pg_temp.id('TS')));
  PERFORM pg_temp.rec('d45_acknowledge_window', p_usr, format($q$public.d45_acknowledge_window(%L::uuid, 'helpful', 'n')$q$, v_win));
  PERFORM pg_temp.rec('d45_record_forecast_history', p_usr,
    $q$public.d45_record_forecast_history(ARRAY['short'], ARRAY['health'], 1, 1, 1, 1, 10)$q$);

  PERFORM pg_temp.rec('d50_store_reinforcement', p_usr, $q$public.d50_store_reinforcement('health', 80, 'w', 'm')$q$);
  PERFORM pg_temp.rec('d50_update_eligibility_cache', p_usr, $q$public.d50_update_eligibility_cache('health', true, 80, 5)$q$);
END $$;

SELECT pg_temp.run_all('W1');
SELECT pg_temp.run_all('W0');
SELECT pg_temp.run_all('W2');

-- Writer tables, with the user column each uses.
CREATE TEMP TABLE t05571w_tables (t text PRIMARY KEY);
INSERT INTO t05571w_tables VALUES
  ('availability_assessments'), ('availability_overrides'), ('user_personal_boundaries'), ('user_consent_states'),
  ('d43_longitudinal_data_points'), ('d43_adaptation_plans'), ('d43_preference_snapshots'),
  ('d44_predictive_signals'), ('d44_signal_evidence'), ('d44_intervention_history'),
  ('d45_predictive_windows'), ('d45_window_feedback'), ('d45_forecast_history'),
  ('d50_positive_reinforcements'), ('d50_trajectory_eligibility_cache');

-- rows of the three test users in one table, optionally for one tenant.
CREATE FUNCTION pg_temp.rows_of(p_table text, p_tenant uuid) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  EXECUTE format('SELECT count(*) FROM public.%I WHERE user_id = ANY (%L::uuid[]) AND ($1 IS NULL OR tenant_id = $1)', p_table,
                 ARRAY[pg_temp.id('W1'), pg_temp.id('W0'), pg_temp.id('W2')]) INTO n USING p_tenant;
  RETURN n;
END $$;
CREATE FUNCTION pg_temp.rows_of_user(p_table text, p_usr text, p_tenant uuid) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  EXECUTE format('SELECT count(*) FROM public.%I WHERE user_id = $1 AND tenant_id = $2', p_table) INTO n USING pg_temp.id(p_usr), p_tenant;
  RETURN n;
END $$;

-- 1 primary: every function succeeds (19) ------------------------------------------------------
SELECT ok(res IS NOT NULL AND raised IS NULL AND pg_temp.jerr(res) IS NULL AND res NOT LIKE '%"ok": false%',
          fn || ': a caller with one primary row succeeds')
  FROM (SELECT fn, res, raised FROM t05571w_calls WHERE usr = 'W1' ORDER BY fn) c;

-- ...and the rows land in that tenant (the writer tables, W1 only).
SELECT is((SELECT count(*) FROM t05571w_tables t
            WHERE pg_temp.rows_of_user(t.t, 'W1', pg_temp.id('TA')) > 0), 15::bigint,
  'W1 wrote a row in all 15 writer tables, each under its primary tenant');
SELECT is((SELECT sum(pg_temp.rows_of_user(t.t, 'W1', pg_temp.id('TB')))::bigint FROM t05571w_tables t), 0::bigint,
  'W1 wrote nothing under any other tenant');

-- 0 primaries: closed (19 -> one aggregate per user) ---------------------------------------------
SELECT is((SELECT count(*) FROM t05571w_calls WHERE usr = 'W0'
            AND (pg_temp.jerr(res) = 'TENANT_UNRESOLVED' OR raised LIKE 'P0001: TENANT_UNRESOLVED%'
                 OR (fn = 'd45_record_forecast_history' AND res IS NULL AND raised IS NULL))), 19::bigint,
  'a caller with no primary row fails closed in all 19 functions (TENANT_UNRESOLVED / raise / NULL)');
SELECT is((SELECT count(*) FROM t05571w_calls WHERE usr = 'W2'
            AND (pg_temp.jerr(res) = 'TENANT_UNRESOLVED' OR raised LIKE 'P0001: TENANT_UNRESOLVED%'
                 OR (fn = 'd45_record_forecast_history' AND res IS NULL AND raised IS NULL))), 19::bigint,
  'a caller with two primary rows fails closed in all 19 functions');
SELECT is((SELECT count(*) FROM t05571w_calls WHERE usr IN ('W0', 'W2') AND raised IS NOT NULL AND raised NOT LIKE 'P0001: TENANT_UNRESOLVED%'), 0::bigint,
  'the only exception a fail-closed call raises is TENANT_UNRESOLVED');
SELECT is((SELECT sum(pg_temp.rows_of_user(t.t, 'W0', pg_temp.id('TA')) + pg_temp.rows_of_user(t.t, 'W2', pg_temp.id('TA'))
                    + pg_temp.rows_of_user(t.t, 'W2', pg_temp.id('TB')))::bigint FROM t05571w_tables t), 0::bigint,
  'the 0-primary and 2-primary callers wrote no row under any tenant');
SELECT is((SELECT sum(pg_temp.rows_of(t.t, '00000000-0000-0000-0000-000000000001'::uuid))::bigint FROM t05571w_tables t), 0::bigint,
  'no writer wrote a row with tenant ...0001 for any of the three callers');

-- 01127 with a NULL auth.uid() ------------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claims', '', true);
CREATE TEMP TABLE t05571w_anon AS
  SELECT 'availability_compute' AS fn, public.availability_compute()::text AS res
  UNION ALL SELECT 'availability_get_override', public.availability_get_override()::text
  UNION ALL SELECT 'availability_set_override', public.availability_set_override(NULL, 'low', 15, NULL, 'x')::text
  UNION ALL SELECT 'availability_clear_override', public.availability_clear_override()::text
  UNION ALL SELECT 'availability_get_recent', public.availability_get_recent()::text;
SELECT is(pg_temp.jerr(res), 'UNAUTHENTICATED', fn || ': NULL auth.uid() returns UNAUTHENTICATED') FROM t05571w_anon ORDER BY fn;
SELECT is((SELECT count(*) FROM public.availability_assessments WHERE user_id = '00000000-0000-0000-0000-000000000099')
        + (SELECT count(*) FROM public.availability_overrides WHERE user_id = '00000000-0000-0000-0000-000000000099'), 0::bigint,
  'no ...0099 availability row was written');

-- Bodies and grants -----------------------------------------------------------------------------------
CREATE TEMP TABLE t05571w_fns AS
  SELECT p.oid::regprocedure AS fn, p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (
    'availability_compute', 'availability_get_override', 'availability_set_override', 'availability_clear_override', 'availability_get_recent',
    'd41_set_personal_boundary', 'd41_set_consent', 'd43_record_data_point', 'd43_create_adaptation_plan', 'd43_create_snapshot',
    'd44_create_signal', 'd44_add_signal_evidence', 'd44_update_signal_status', 'd44_record_intervention',
    'd45_store_window', 'd45_acknowledge_window', 'd45_record_forecast_history', 'd50_store_reinforcement', 'd50_update_eligibility_cache');
SELECT is((SELECT count(*) FROM t05571w_fns), 19::bigint, 'all 19 repointed functions exist');
SELECT is((SELECT count(*) FROM t05571w_fns
            WHERE pg_get_functiondef(fn) LIKE '%00000000-0000-0000-0000-000000000001%'
               OR pg_get_functiondef(fn) LIKE '%00000000-0000-0000-0000-000000000099%'), 0::bigint,
  'no repointed body contains the ...0001 or ...0099 literal (pg_get_functiondef)');
SELECT is((SELECT count(*) FROM t05571w_fns f JOIN pg_proc p ON p.oid = f.fn::oid WHERE NOT p.prosecdef), 0::bigint,
  'every repointed function is still SECURITY DEFINER');
SELECT is((SELECT count(*) FROM t05571w_fns f JOIN pg_proc p ON p.oid = f.fn::oid
            WHERE p.proconfig IS DISTINCT FROM ARRAY['search_path=public']), 0::bigint, 'search_path is unchanged (public)');
SELECT ok((SELECT bool_and(has_function_privilege('authenticated', f.fn, 'EXECUTE')) FROM t05571w_fns f
            WHERE f.proname <> 'availability_cleanup_expired'),
  'authenticated still holds EXECUTE on every repointed function (grants unchanged)');
SELECT ok(NOT has_function_privilege('anon', 'public.mt_orphan_repoint_gate()', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.mt_orphan_repoint_gate()', 'EXECUTE')
      AND has_function_privilege('service_role', 'public.mt_orphan_repoint_gate()', 'EXECUTE'),
  'the gate function is service_role only (the writers keep exactly their original ACL; the migration RAISEs otherwise)');

-- d45_acknowledge_window: JSON error like its 18 siblings, no raise, window untouched -----------------------
SELECT is((SELECT count(*) FROM t05571w_calls WHERE fn = 'd45_acknowledge_window' AND usr IN ('W0', 'W2')
            AND pg_temp.jerr(res) = 'TENANT_UNRESOLVED' AND raised IS NULL), 2::bigint,
  'd45_acknowledge_window returns {ok:false,error:TENANT_UNRESOLVED} (no raise) for the 0-primary and 2-primary callers');
SELECT is((SELECT count(*) FROM public.d45_predictive_windows
            WHERE user_id IN (pg_temp.id('W0'), pg_temp.id('W2')) AND (status = 'acknowledged' OR acknowledged_at IS NOT NULL)), 0::bigint,
  'a fail-closed d45_acknowledge_window leaves the window unacknowledged (the tenant resolves before the UPDATE)');

-- Gate ----------------------------------------------------------------------------------------------
SELECT lives_ok($$ SELECT public.mt_orphan_repoint_gate() $$, 'gate passes while primary rows exist');
UPDATE public.user_tenants SET is_primary = false;
SELECT throws_ok($$ SELECT public.mt_orphan_repoint_gate() $$, 'P0001', NULL,
  'gate RAISEs on a fixture with the column but zero primary rows');

-- empty user_tenants: refused on a database that has accounts, allowed on a fresh stack (both empty)
DELETE FROM public.user_tenants;
INSERT INTO auth.users (id, email)
SELECT pg_temp.id(k), 'vtid05571w-' || lower(k) || '@vitanatest.exafy.io' FROM t05571w_ids WHERE k LIKE 'W%'
ON CONFLICT (id) DO NOTHING;
SELECT throws_ok($$ SELECT public.mt_orphan_repoint_gate() $$, 'P0001', NULL,
  'gate RAISEs on an empty user_tenants while auth.users has accounts (backfill not run)');

-- partial backfill: 1 of 3, then 2 of 3 accounts covered (minimum 95 percent)
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES (pg_temp.id('TA'), pg_temp.id('W1'), true);
SELECT throws_ok($$ SELECT public.mt_orphan_repoint_gate() $$, 'P0001', NULL,
  'gate RAISEs when only 1 of 3 auth.users accounts has a primary row (partial backfill)');
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES (pg_temp.id('TA'), pg_temp.id('W0'), true);
SELECT throws_ok($$ SELECT public.mt_orphan_repoint_gate() $$, 'P0001', NULL,
  'gate RAISEs when only 2 of 3 auth.users accounts have a primary row (below the 95 percent minimum)');
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES (pg_temp.id('TA'), pg_temp.id('W2'), true);
SELECT lives_ok($$ SELECT public.mt_orphan_repoint_gate() $$, 'gate passes when every auth.users account has a primary row');

-- fresh local stack: no accounts and no memberships
DELETE FROM public.user_tenants;
DELETE FROM auth.users;
SELECT lives_ok($$ SELECT public.mt_orphan_repoint_gate() $$, 'gate passes on a fresh stack (user_tenants and auth.users both empty)');

SELECT * FROM finish();
ROLLBACK;
