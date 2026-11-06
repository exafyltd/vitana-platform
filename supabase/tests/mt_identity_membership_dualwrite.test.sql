-- VTID-05466 (mt-identity-r2 / membership-unification, M2, plan Amendment 1) — pgTAP: the deferred
-- memberships -> user_tenants dual-write trigger.
-- Runs with `supabase test db` (pg_prove) on the local stack, after every migration including
-- 20261102031100_vtid_05466_memberships_view_dualwrite.sql. One transaction, rolled back at the end.
-- The trigger is INITIALLY DEFERRED; `SET CONSTRAINTS … IMMEDIATE` fires the pending events at that point
-- inside the transaction, exactly as COMMIT would.
--
-- Covers: memberships stays a table; a legacy insert lands in user_tenants as community; a re-insert is a
-- no-op; the four side-effect triggers fire 0 times; a bot / service-account / inactive / deleted-before-
-- commit / no-app_users insert writes nothing; a legacy writer's own primary row (inserted after its
-- memberships row) is left as the writer made it; no grant row changes; members cannot run the function.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(27);

CREATE TEMP TABLE t05466w_ids (k text PRIMARY KEY, v uuid NOT NULL);
INSERT INTO t05466w_ids VALUES
  ('N',   '05466000-0000-4000-8000-0000000000e1'),  -- legacy-only insert, no membership yet
  ('E',   '05466000-0000-4000-8000-0000000000e2'),  -- already in user_tenants
  ('W',   '05466000-0000-4000-8000-0000000000e3'),  -- legacy writer: memberships first, own primary row after
  ('S',   '05466000-0000-4000-8000-0000000000e4'),  -- service_bot_accounts
  ('I',   '05466000-0000-4000-8000-0000000000e5'),  -- inactive membership
  ('D',   '05466000-0000-4000-8000-0000000000e6'),  -- membership deleted before commit
  ('X',   '05466000-0000-4000-8000-0000000000e7'),  -- no app_users row
  ('BOT', '00000000-0000-0000-0000-000000000001');
CREATE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT v FROM t05466w_ids WHERE k = p $$;
CREATE FUNCTION pg_temp.side_effects(p_user uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT (SELECT count(*) FROM public.chat_messages WHERE sender_id = p_user)
       + (SELECT count(*) FROM public.founding_members WHERE user_id = p_user)
       + (SELECT count(*) FROM public.autopilot_recommendations WHERE user_id = p_user)
       + (SELECT count(*) FROM public.live_rooms WHERE host_user_id = p_user)
$$;
CREATE FUNCTION pg_temp.ut(p_user uuid) RETURNS int LANGUAGE sql STABLE AS
  $$ SELECT count(*)::int FROM public.user_tenants WHERE user_id = p_user $$;
CREATE FUNCTION pg_temp.grant_rows() RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT (SELECT count(*) FROM public.user_permitted_roles)
       + (SELECT count(*) FROM public.role_preferences)
       + (SELECT count(*) FROM public.user_active_roles)
$$;

-- Static shape -----------------------------------------------------------------------------------
SELECT is((SELECT relkind::text FROM pg_class WHERE oid = 'public.memberships'::regclass), 'r',
  'memberships stays a table (Amendment 1)');
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.memberships'::regclass
                   AND tgname = 'memberships_dualwrite_user_tenants' AND tgdeferrable AND tginitdeferred),
  'the dual-write trigger is DEFERRABLE INITIALLY DEFERRED on memberships');
SELECT ok(NOT has_function_privilege('authenticated', 'public.memberships_dualwrite_user_tenants()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.memberships_dualwrite_user_tenants()', 'EXECUTE'),
  'members cannot execute the dual-write function');

-- Fixture ----------------------------------------------------------------------------------------
DO $fx$
DECLARE r jsonb;
BEGIN
  INSERT INTO public.tenants (name, slug)
  VALUES ('VTID-05466 dual-write test tenant', 'vtid-05466-dualwrite-test')
  RETURNING to_jsonb(tenants.*) INTO r;
  INSERT INTO t05466w_ids VALUES ('T', coalesce(r ->> 'tenant_id', r ->> 'id')::uuid);
END
$fx$;

INSERT INTO public.app_users (user_id, email, display_name)
SELECT v, 'vtid05466w-' || lower(k) || '@vitanatest.exafy.io', 'VTID-05466 ' || k
  FROM t05466w_ids WHERE k IN ('N', 'E', 'W', 'S', 'I', 'D', 'BOT')
ON CONFLICT (user_id) DO NOTHING;
INSERT INTO public.service_bot_accounts (user_id, label, reason)
VALUES (pg_temp.id('S'), 'vtid-05466-dualwrite-test', 'VTID-05466 pgTAP fixture')
ON CONFLICT (user_id) DO NOTHING;

SELECT set_config('vitana.suppress_membership_side_effects', 'on', true);
INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
VALUES (pg_temp.id('T'), pg_temp.id('E'), 'community', true);
SELECT set_config('vitana.suppress_membership_side_effects', '', true);

CREATE TEMP TABLE t05466w_before AS
SELECT k, pg_temp.side_effects(v) AS n FROM t05466w_ids WHERE k <> 'T';
CREATE TEMP TABLE t05466w_grants AS SELECT pg_temp.grant_rows() AS n;

-- Legacy inserts (role 'admin' on N: a grant, which must never reach user_tenants).
INSERT INTO public.memberships (user_id, tenant_id, role, status) VALUES
  (pg_temp.id('N'),   pg_temp.id('T'), 'admin',     'active'),
  (pg_temp.id('E'),   pg_temp.id('T'), 'community', 'active'),
  (pg_temp.id('W'),   pg_temp.id('T'), 'community', 'active'),
  (pg_temp.id('S'),   pg_temp.id('T'), 'community', 'active'),
  (pg_temp.id('I'),   pg_temp.id('T'), 'community', 'inactive'),
  (pg_temp.id('D'),   pg_temp.id('T'), 'community', 'active'),
  (pg_temp.id('X'),   pg_temp.id('T'), 'community', 'active'),
  (pg_temp.id('BOT'), pg_temp.id('T'), 'community', 'active');

SELECT is(pg_temp.ut(pg_temp.id('N')), 0, 'deferred: nothing is written before commit');

-- W's own writer path: its primary row after its memberships row (switch_to_tenant_by_slug order).
SELECT set_config('vitana.suppress_membership_side_effects', 'on', true);
INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
VALUES (pg_temp.id('T'), pg_temp.id('W'), 'community', true);
SELECT set_config('vitana.suppress_membership_side_effects', '', true);

DELETE FROM public.memberships WHERE user_id = pg_temp.id('D') AND tenant_id = pg_temp.id('T');

SELECT lives_ok($$SET CONSTRAINTS public.memberships_dualwrite_user_tenants IMMEDIATE$$,
  'the pending dual-write events fire (as at commit) without an error');

-- N: written as a community membership, primary because it had none.
SELECT is(pg_temp.ut(pg_temp.id('N')), 1, 'a legacy memberships insert lands in user_tenants');
SELECT is((SELECT active_role FROM public.user_tenants WHERE user_id = pg_temp.id('N')), 'community',
  'active_role is community, never memberships.role');
SELECT ok((SELECT is_primary FROM public.user_tenants WHERE user_id = pg_temp.id('N')),
  'a user with no primary membership gets a primary row');
SELECT is((SELECT role::text FROM public.memberships WHERE user_id = pg_temp.id('N')), 'admin',
  'memberships.role is untouched');

-- N1: the four side-effect triggers fired 0 times for every user.
SELECT is((SELECT count(*)::int FROM public.chat_messages WHERE sender_id = pg_temp.id('N')), 0, 'dual-write: 0 welcome chats');
SELECT is((SELECT count(*)::int FROM public.founding_members WHERE user_id = pg_temp.id('N')), 0, 'dual-write: 0 founding seats');
SELECT is((SELECT count(*)::int FROM public.autopilot_recommendations WHERE user_id = pg_temp.id('N')), 0, 'dual-write: 0 autopilot rows');
SELECT is((SELECT count(*)::int FROM public.live_rooms WHERE host_user_id = pg_temp.id('N')), 0, 'dual-write: 0 live rooms');
SELECT is((SELECT count(*)::int FROM t05466w_before b WHERE pg_temp.side_effects(pg_temp.id(b.k)) <> b.n), 0,
  'no user got any side effect from the dual-write');
SELECT ok(NOT public.membership_side_effects_suppressed(), 'the suppression setting is back off');

-- Existing membership: the dual-write is a no-op.
SELECT is(pg_temp.ut(pg_temp.id('E')), 1, 'a membership that already exists in user_tenants adds no row');
-- Legacy writer: its own primary row is kept as the writer made it.
SELECT is(pg_temp.ut(pg_temp.id('W')), 1, 'the legacy writer''s own user_tenants row is the only one');
SELECT ok((SELECT is_primary FROM public.user_tenants WHERE user_id = pg_temp.id('W')),
  'the legacy writer''s primary flag is unchanged (deferred, the trigger ran after it)');

-- Excluded inserts write nothing.
SELECT is(pg_temp.ut(pg_temp.id('BOT')), 0, 'a bot memberships insert writes no user_tenants row');
SELECT is((SELECT count(*)::int FROM public.chat_messages WHERE sender_id = pg_temp.id('BOT')),
          (SELECT n FROM t05466w_before WHERE k = 'BOT')::int,
  'a bot memberships insert yields 0 new chat_messages');
SELECT is(pg_temp.ut(pg_temp.id('S')), 0, 'a service_bot_accounts insert writes nothing');
SELECT is(pg_temp.ut(pg_temp.id('I')), 0, 'an inactive membership writes nothing');
SELECT is(pg_temp.ut(pg_temp.id('D')), 0, 'a membership deleted before commit writes nothing');
SELECT is(pg_temp.ut(pg_temp.id('X')), 0, 'a user without app_users writes nothing (and the writer does not fail)');

-- Re-insert of an existing memberships row: ON CONFLICT DO NOTHING, no new event, no new row.
INSERT INTO public.memberships (user_id, tenant_id, role, status)
VALUES (pg_temp.id('N'), pg_temp.id('T'), 'community', 'active')
ON CONFLICT (user_id, tenant_id) DO NOTHING;
SET CONSTRAINTS public.memberships_dualwrite_user_tenants IMMEDIATE;
SELECT is(pg_temp.ut(pg_temp.id('N')), 1, 're-inserting an existing membership is a no-op');
SELECT is(pg_temp.side_effects(pg_temp.id('N')), (SELECT n FROM t05466w_before WHERE k = 'N'),
  're-inserting an existing membership fires none of the four side effects');

-- No grant row changed anywhere.
SELECT is(pg_temp.grant_rows(), (SELECT n FROM t05466w_grants),
  'user_permitted_roles, role_preferences and user_active_roles are unchanged');

SELECT * FROM finish();
ROLLBACK;
