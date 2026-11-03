-- mt-identity-r2 / helpers-and-policy-rewrite (VTID-05465) — pgTAP: helpers + rewritten policies.
-- Runs on a throwaway Postgres after supabase/tests/mt_identity_helpers_fixture.sql,
-- 20261102030000_vtid_05465_tenant_id_for_policies_is_member.sql and
-- 20261102030100_vtid_05465_bare_policy_rewrite.sql. Never against a shared or live database.
-- Everything runs in one transaction that is rolled back.
--
-- Users: a_admin ...0a5401 (A), a_member ...0a5402 (A), b_member ...0b5403 (B),
--        ab_member ...0c5404 (A primary, also B). Tenants A ...0a...5465, B ...0b...5465.
-- The 5 no-policy tables (access_audit_log, consents, retrieval_traces, role_sessions,
-- user_roles) are out of scope and not asserted.
-- Plan amendment 1: every rewritten policy admits exactly today's audience, the members of the
-- caller's one resolved tenant (tenant_id_for_policies(), as current_tenant_id() resolves it
-- today). The behaviour assertions in sections 2-4 therefore hold on origin/main's policies too;
-- only sections 5-6 (helper name, plan shape) tell the two apart.
BEGIN;
SELECT no_plan();

CREATE SCHEMA t05465;
GRANT USAGE ON SCHEMA t05465 TO authenticated;

-- Runs p_sql as `authenticated` with JWT sub = p_user (NULL: no sub) plus p_claims.
-- Returns 'rows:<n>' or 'error:<SQLSTATE>'.
CREATE FUNCTION t05465.run_as(p_user uuid, p_sql text, p_claims jsonb DEFAULT '{}'::jsonb)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE n bigint; v text;
BEGIN
  PERFORM set_config('request.jwt.claims',
    (jsonb_build_object('role', 'authenticated') || coalesce(jsonb_build_object('sub', p_user), '{}'::jsonb)
      || p_claims)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    v := 'rows:' || n;
  EXCEPTION WHEN OTHERS THEN
    v := 'error:' || SQLSTATE;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v;
END $$;

-- Same, returning the first column of the first row as text.
CREATE FUNCTION t05465.val_as(p_user uuid, p_sql text, p_claims jsonb DEFAULT '{}'::jsonb)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims',
    (jsonb_build_object('role', 'authenticated') || coalesce(jsonb_build_object('sub', p_user), '{}'::jsonb)
      || p_claims)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  EXECUTE p_sql INTO v;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v;
END $$;

-- EXPLAIN (FORMAT JSON) of p_sql as the current role (the helpers' owner).
CREATE FUNCTION t05465.plan_of(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  EXECUTE 'EXPLAIN (FORMAT JSON) ' || p_sql INTO v;
  RETURN regexp_replace(v, '\s+', ' ', 'g');
END $$;

-- ---------------------------------------------------------------------------
-- 1. Helpers (hook OFF: no top-level tenant_id claim unless a test sets one)
-- ---------------------------------------------------------------------------
SELECT ok((SELECT prosecdef AND provolatile = 's' FROM pg_proc WHERE oid = 'public.is_member(uuid)'::regprocedure),
  'is_member(uuid) is STABLE SECURITY DEFINER');
SELECT ok((SELECT prosecdef AND provolatile = 's' FROM pg_proc WHERE oid = 'public.tenant_id_for_policies()'::regprocedure),
  'tenant_id_for_policies() is STABLE SECURITY DEFINER');
SELECT ok(has_function_privilege('authenticated', 'public.is_member(uuid)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.tenant_id_for_policies()', 'EXECUTE'),
  'authenticated may execute both helpers');
SELECT ok(NOT has_function_privilege('anon', 'public.is_member(uuid)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.tenant_id_for_policies()', 'EXECUTE'),
  'anon may execute neither helper');
SELECT ok((SELECT position('tenant_id_for_policies' IN prosrc) = 0 FROM pg_proc WHERE oid = 'public.current_tenant_id()'::regprocedure),
  'current_tenant_id() is not redefined');

SELECT is(t05465.val_as('00000000-0000-0000-0000-0000000a5402', 'SELECT public.tenant_id_for_policies()::text'),
  '0000000a-0000-0000-0000-000000005465', 'hook off: a_member resolves to primary tenant A');
SELECT is(t05465.val_as('00000000-0000-0000-0000-0000000c5404', 'SELECT public.tenant_id_for_policies()::text'),
  '0000000a-0000-0000-0000-000000005465', 'hook off: ab_member resolves to primary tenant A');
SELECT is(t05465.val_as('00000000-0000-0000-0000-0000000c5404', 'SELECT public.tenant_id_for_policies()::text',
  '{"tenant_id":"0000000b-0000-0000-0000-000000005465"}'),
  '0000000b-0000-0000-0000-000000005465', 'claim B for a member of B: B');
SELECT is(t05465.val_as('00000000-0000-0000-0000-0000000a5402', 'SELECT public.tenant_id_for_policies()::text',
  '{"tenant_id":"0000000b-0000-0000-0000-000000005465"}'),
  '0000000a-0000-0000-0000-000000005465', 'claim B for a non-member of B: falls back to primary A');
SELECT is(t05465.val_as('00000000-0000-0000-0000-0000000a5402', 'SELECT public.tenant_id_for_policies()::text',
  '{"tenant_id":"not-a-uuid"}'),
  '0000000a-0000-0000-0000-000000005465', 'malformed claim: falls back to primary A');
SELECT is(t05465.val_as(NULL, 'SELECT public.tenant_id_for_policies()::text'), NULL::text, 'no auth.uid(): NULL');
SELECT is(t05465.val_as('00000000-0000-0000-0000-00000000dead', 'SELECT public.tenant_id_for_policies()::text'),
  NULL::text, 'user without membership: NULL');

SELECT is(t05465.val_as('00000000-0000-0000-0000-0000000a5402', $$SELECT public.is_member('0000000a-0000-0000-0000-000000005465')::text$$),
  'true', 'a_member is a member of A');
SELECT is(t05465.val_as('00000000-0000-0000-0000-0000000a5402', $$SELECT public.is_member('0000000b-0000-0000-0000-000000005465')::text$$),
  'false', 'a_member is not a member of B');
SELECT is(t05465.val_as('00000000-0000-0000-0000-0000000c5404', $$SELECT public.is_member('0000000b-0000-0000-0000-000000005465')::text$$),
  'true', 'ab_member is a member of B');
SELECT is(t05465.val_as('00000000-0000-0000-0000-0000000a5402', 'SELECT public.is_member(NULL)::text'),
  'false', 'is_member(NULL) is false');
SELECT is(t05465.val_as(NULL, $$SELECT public.is_member('0000000a-0000-0000-0000-000000005465')::text$$),
  'false', 'is_member without auth.uid() is false');

-- ---------------------------------------------------------------------------
-- 2. Attendance tables (have a user_id column): today's audience is kept, so a member reads
--    every row of the resolved tenant, a_admin's included (/admin/live/attendance).
-- ---------------------------------------------------------------------------
SELECT is(t05465.run_as('00000000-0000-0000-0000-0000000a5402',
  format('SELECT 1 FROM public.%I WHERE user_id = %L', t, '00000000-0000-0000-0000-0000000a5401')),
  'rows:1', format('%s: a_member still reads a_admin''s row, as today', t))
FROM unnest(ARRAY['event_attendance', 'live_room_attendance']) t;
SELECT is(t05465.run_as('00000000-0000-0000-0000-0000000a5402', format('SELECT 1 FROM public.%I', t)),
  'rows:2', format('%s: a_member reads every tenant A row and nothing else', t))
FROM unnest(ARRAY['event_attendance', 'live_room_attendance']) t;
SELECT is(t05465.run_as('00000000-0000-0000-0000-0000000b5403',
  format('SELECT 1 FROM public.%I WHERE tenant_id = %L', t, '0000000a-0000-0000-0000-000000005465')),
  'rows:0', format('%s: b_member reads nothing of tenant A', t))
FROM unnest(ARRAY['event_attendance', 'live_room_attendance']) t;
SELECT is(t05465.run_as('00000000-0000-0000-0000-0000000c5404',
  format('SELECT 1 FROM public.%I WHERE tenant_id = %L', t, '0000000b-0000-0000-0000-000000005465')),
  'rows:0', format('%s: a member of A (resolved) and B reads nothing of tenant B', t))
FROM unnest(ARRAY['event_attendance', 'live_room_attendance']) t;
SELECT is(t05465.run_as('00000000-0000-0000-0000-00000000dead', format('SELECT 1 FROM public.%I', t)),
  'rows:0', format('%s: a user with no membership reads nothing', t))
FROM unnest(ARRAY['event_attendance', 'live_room_attendance']) t;

-- 2b. Health tables (read-only check; their policies are not rewritten here).
SELECT is(t05465.run_as('00000000-0000-0000-0000-0000000a5402',
  format('SELECT 1 FROM public.%I WHERE user_id = %L', t, '00000000-0000-0000-0000-0000000a5401')),
  'rows:0', format('health %s: a_member cannot read a_admin''s row', t))
FROM unnest(ARRAY['lab_reports', 'biomarker_results', 'wearable_samples', 'health_features_daily',
                  'vitana_index_scores', 'recommendations', 'safety_constraints']) t;

-- ---------------------------------------------------------------------------
-- 3. Shared SELECT policies admit the members of the resolved tenant only
-- ---------------------------------------------------------------------------
SELECT is(t05465.run_as('00000000-0000-0000-0000-0000000a5402',
  format('SELECT 1 FROM public.%I WHERE tenant_id = %L', t, '0000000a-0000-0000-0000-000000005465')),
  'rows:1', format('%s: a_member reads tenant A', t))
FROM unnest(ARRAY['community_listings', 'd42_domain_weights', 'live_highlights', 'live_rooms', 'products_catalog',
                  'services_catalog', 'tenant_catalog_overrides', 'match_targets', 'relationship_nodes',
                  'social_alignment_signals', 'topic_registry']) t;
SELECT is(t05465.run_as('00000000-0000-0000-0000-0000000b5403',
  format('SELECT 1 FROM public.%I WHERE tenant_id = %L', t, '0000000a-0000-0000-0000-000000005465')),
  'rows:0', format('%s: b_member reads nothing of tenant A', t))
FROM unnest(ARRAY['community_listings', 'd42_domain_weights', 'live_highlights', 'live_rooms', 'products_catalog',
                  'services_catalog', 'tenant_catalog_overrides', 'match_targets', 'relationship_nodes',
                  'social_alignment_signals', 'topic_registry']) t;
SELECT is(t05465.run_as('00000000-0000-0000-0000-0000000b5403',
  format('SELECT 1 FROM public.%I WHERE tenant_id = %L', t, '0000000b-0000-0000-0000-000000005465')),
  'rows:1', format('%s: b_member reads tenant B', t))
FROM unnest(ARRAY['community_listings', 'd42_domain_weights', 'live_highlights', 'live_rooms', 'products_catalog',
                  'services_catalog', 'tenant_catalog_overrides', 'match_targets', 'relationship_nodes',
                  'social_alignment_signals', 'topic_registry']) t;
SELECT is(t05465.run_as('00000000-0000-0000-0000-00000000dead', format('SELECT 1 FROM public.%I', t)),
  'rows:0', format('%s: a user with no membership reads nothing', t))
FROM unnest(ARRAY['community_listings', 'live_highlights', 'live_rooms', 'products_catalog',
                  'services_catalog', 'tenant_catalog_overrides', 'match_targets', 'relationship_nodes',
                  'social_alignment_signals', 'topic_registry']) t;

-- A member of two tenants reads only the resolved tenant's shared rows (A, the primary row),
-- not the second tenant's (B), as today.
SELECT is(t05465.run_as('00000000-0000-0000-0000-0000000c5404',
  format('SELECT 1 FROM public.%I WHERE tenant_id = %L', t, '0000000a-0000-0000-0000-000000005465')),
  'rows:1', format('%s: a member of A (resolved) and B reads tenant A', t))
FROM unnest(ARRAY['community_listings', 'd42_domain_weights', 'live_highlights', 'live_rooms', 'products_catalog',
                  'services_catalog', 'tenant_catalog_overrides', 'match_targets', 'relationship_nodes',
                  'social_alignment_signals', 'topic_registry']) t;
SELECT is(t05465.run_as('00000000-0000-0000-0000-0000000c5404',
  format('SELECT 1 FROM public.%I WHERE tenant_id = %L', t, '0000000b-0000-0000-0000-000000005465')),
  'rows:0', format('%s: a member of A (resolved) and B reads nothing of tenant B', t))
FROM unnest(ARRAY['community_listings', 'd42_domain_weights', 'live_highlights', 'live_rooms', 'products_catalog',
                  'services_catalog', 'tenant_catalog_overrides', 'match_targets', 'relationship_nodes',
                  'social_alignment_signals', 'topic_registry']) t;
-- With a top-level tenant_id claim for B (the later hook), B is the resolved tenant instead.
SELECT is(t05465.run_as('00000000-0000-0000-0000-0000000c5404',
  format('SELECT 1 FROM public.live_rooms WHERE tenant_id = %L', '0000000a-0000-0000-0000-000000005465'),
  '{"tenant_id":"0000000b-0000-0000-0000-000000005465"}'),
  'rows:0', 'live_rooms: claim B resolves B, so tenant A is hidden');
SELECT is(t05465.run_as('00000000-0000-0000-0000-0000000c5404',
  format('SELECT 1 FROM public.live_rooms WHERE tenant_id = %L', '0000000b-0000-0000-0000-000000005465'),
  '{"tenant_id":"0000000b-0000-0000-0000-000000005465"}'),
  'rows:1', 'live_rooms: claim B resolves B, so tenant B is shown');

-- Extra predicates kept.
SELECT is(t05465.run_as('00000000-0000-0000-0000-0000000a5402',
  $$SELECT 1 FROM public.community_listings WHERE status = 'draft'$$),
  'rows:0', 'community_listings_select_public keeps its status filter (draft hidden)');
SELECT is(t05465.run_as('00000000-0000-0000-0000-0000000b5403',
  $$SELECT 1 FROM public.d42_domain_weights WHERE tenant_id = '00000000-0000-0000-0000-000000000001'$$),
  'rows:1', 'd42_domain_weights_select keeps the global-defaults row for every member');
SELECT is(t05465.run_as('00000000-0000-0000-0000-00000000dead', 'SELECT 1 FROM public.d42_domain_weights'),
  'rows:1', 'd42_domain_weights: a non-member reads only the global defaults');

-- ---------------------------------------------------------------------------
-- 4. Writes: any member of the resolved tenant, nobody else
--    (UPDATE and DELETE first, on the seeded rows; INSERT last)
-- ---------------------------------------------------------------------------
SELECT is(t05465.run_as('00000000-0000-0000-0000-0000000b5403',
  format('UPDATE public.%I SET tenant_id = tenant_id WHERE tenant_id = %L', t, '0000000a-0000-0000-0000-000000005465')),
  'rows:0', format('%s: b_member updates nothing of tenant A', t))
FROM unnest(ARRAY['community_groups', 'community_meetups', 'live_rooms', 'match_targets', 'relationship_nodes', 'topic_registry']) t;
SELECT is(t05465.run_as('00000000-0000-0000-0000-0000000a5402',
  format('UPDATE public.%I SET tenant_id = tenant_id WHERE tenant_id = %L', t, '0000000a-0000-0000-0000-000000005465')),
  'rows:1', format('%s: a_member updates the tenant A row', t))
FROM unnest(ARRAY['community_groups', 'community_meetups', 'live_rooms', 'match_targets', 'relationship_nodes', 'topic_registry']) t;
SELECT is(t05465.run_as('00000000-0000-0000-0000-0000000a5402',
  format('UPDATE public.%I SET tenant_id = %L WHERE tenant_id = %L', t,
         '0000000b-0000-0000-0000-000000005465', '0000000a-0000-0000-0000-000000005465')),
  'error:42501', format('%s: a_member cannot move a row into tenant B', t))
FROM unnest(ARRAY['community_groups', 'community_meetups', 'live_rooms', 'match_targets', 'relationship_nodes', 'topic_registry']) t;

SELECT is(t05465.run_as('00000000-0000-0000-0000-0000000b5403',
  format('DELETE FROM public.%I WHERE tenant_id = %L', t, '0000000a-0000-0000-0000-000000005465')),
  'rows:0', format('%s: b_member deletes nothing of tenant A', t))
FROM unnest(ARRAY['community_groups', 'community_meetups', 'relationship_nodes', 'topic_registry']) t;
SELECT is(t05465.run_as('00000000-0000-0000-0000-0000000a5402',
  format('DELETE FROM public.%I WHERE tenant_id = %L', t, '0000000a-0000-0000-0000-000000005465')),
  'rows:1', format('%s: a_member deletes the tenant A row', t))
FROM unnest(ARRAY['community_groups', 'community_meetups', 'relationship_nodes', 'topic_registry']) t;

SELECT is(t05465.run_as('00000000-0000-0000-0000-0000000b5403',
  format('INSERT INTO public.%I (tenant_id) VALUES (%L)', t, '0000000a-0000-0000-0000-000000005465')),
  'error:42501', format('%s: b_member cannot insert into tenant A', t))
FROM unnest(ARRAY['community_groups', 'community_meetups', 'live_rooms', 'products_catalog', 'services_catalog',
                  'match_targets', 'relationship_nodes', 'social_alignment_signals', 'topic_registry']) t;
SELECT is(t05465.run_as('00000000-0000-0000-0000-0000000a5402',
  format('INSERT INTO public.%I (tenant_id) VALUES (%L)', t, '0000000a-0000-0000-0000-000000005465')),
  'rows:1', format('%s: a_member inserts into tenant A', t))
FROM unnest(ARRAY['community_groups', 'community_meetups', 'live_rooms', 'products_catalog', 'services_catalog',
                  'match_targets', 'relationship_nodes', 'social_alignment_signals', 'topic_registry']) t;

SELECT is(t05465.run_as('00000000-0000-0000-0000-0000000c5404',
  format('INSERT INTO public.%I (tenant_id) VALUES (%L)', t, '0000000b-0000-0000-0000-000000005465')),
  'error:42501', format('%s: a member of A (resolved) and B cannot insert into tenant B', t))
FROM unnest(ARRAY['community_groups', 'live_rooms', 'topic_registry']) t;

-- ---------------------------------------------------------------------------
-- 5. The bare-policy lint, in SQL: no policy filters on current_tenant_id() alone
-- ---------------------------------------------------------------------------
SELECT is((SELECT count(*)::int FROM pg_policies
           WHERE schemaname = 'public'
             AND coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ 'current_tenant_id\('
             AND coalesce(qual, '') || ' ' || coalesce(with_check, '')
                 !~ '(auth\.uid|current_user_id|is_member|is_tenant_admin|auth\.role)\('
             AND NOT roles <@ ARRAY['service_role', 'postgres', 'supabase_admin']::name[]),
  0, 'no bare current_tenant_id() policy is left');

-- Amendment 1: every rewritten policy uses tenant_id_for_policies(); none uses is_member()
-- or gains a user_id / auth.uid() term.
SELECT is((SELECT count(*)::int FROM pg_policies
           WHERE schemaname = 'public'
             AND coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ 'tenant_id_for_policies\('),
  32, '32 policies filter on tenant_id_for_policies()');
SELECT is((SELECT count(*)::int FROM pg_policies
           WHERE schemaname = 'public'
             AND coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ 'is_member\('),
  0, 'no policy uses is_member()');
SELECT is((SELECT count(*)::int FROM pg_policies
           WHERE schemaname = 'public'
             AND coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ 'tenant_id_for_policies\('
             AND coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ '(auth\.uid\(|user_id)'),
  0, 'no rewritten policy gained a user_id / auth.uid() term');

-- ---------------------------------------------------------------------------
-- 6. Plan shape: tenant_id_for_policies() is uncorrelated, so it runs once per statement
--    (InitPlan), on the largest shared table (live_rooms) and on the attendance tables.
--    is_member() (created for later lanes) is one index probe bounded to one row.
-- ---------------------------------------------------------------------------
SELECT ok(t05465.val_as('00000000-0000-0000-0000-0000000a5402',
            'EXPLAIN (FORMAT JSON) SELECT id FROM public.live_rooms') ~ '"Subplan Name": "InitPlan',
  'live_rooms: tenant_id_for_policies() runs once per statement (InitPlan)');
SELECT is((SELECT count(*)::int FROM regexp_matches(
            t05465.val_as('00000000-0000-0000-0000-0000000a5402',
              'EXPLAIN (VERBOSE, FORMAT JSON) SELECT id FROM public.live_rooms'),
            'is_member\(', 'g')),
  0, 'live_rooms: no is_member() call in the plan');
SELECT ok(t05465.val_as('00000000-0000-0000-0000-0000000a5402',
            'EXPLAIN (FORMAT JSON) SELECT id FROM public.event_attendance') ~ '"Subplan Name": "InitPlan',
  'event_attendance: tenant_id_for_policies() runs once per statement (InitPlan)');
SELECT ok(t05465.plan_of($$SELECT 1 FROM public.user_tenants ut
                           WHERE ut.tenant_id = '0000000a-0000-0000-0000-000000005465'
                             AND ut.user_id = '00000000-0000-0000-0000-0000000a5402'$$)
          ~ '"Node Type": "Index (Only )?Scan".*"Relation Name": "user_tenants"',
  'the is_member() probe is an index scan on user_tenants');
SELECT ok(t05465.plan_of($$SELECT 1 FROM public.user_tenants ut
                           WHERE ut.tenant_id = '0000000a-0000-0000-0000-000000005465'
                             AND ut.user_id = '00000000-0000-0000-0000-0000000a5402'$$)
          ~ '"Plan Rows": 1[,}]',
  'the probe is bounded to one row (unique (tenant_id, user_id))');

SELECT * FROM finish();
ROLLBACK;
