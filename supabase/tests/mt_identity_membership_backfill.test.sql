-- VTID-05466 (mt-identity-r2 / membership-unification) — pgTAP: the memberships -> user_tenants backfill.
-- Runs with `supabase test db` (pg_prove) on the local stack, after every migration including
-- 20261102031000_vtid_05466_user_tenants_canonical.sql. One transaction, rolled back at the end: it
-- never runs against a shared or live database.
--
-- Covers (tasks.md membership-unification Acceptance):
--  * the four primary-membership side-effect triggers do not fire on the backfill (0 welcome chats,
--    founding seats, autopilot rows, live rooms) — with a positive control proving they are armed;
--  * a re-insert of an existing membership fires nothing (ON CONFLICT (tenant_id, user_id) DO NOTHING);
--  * the bot user …0001 and a service_bot_accounts user are never backfilled, and the bot yields
--    0 chat_messages;
--  * non-active memberships are never backfilled; memberships.role never becomes active_role;
--  * the suppression setting is back off after the backfill; members cannot run the backfill.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(24);

-- Fixture ---------------------------------------------------------------------------------------
CREATE TEMP TABLE t05466_ids (k text PRIMARY KEY, v uuid NOT NULL);
INSERT INTO t05466_ids VALUES
  ('A',   '05466000-0000-4000-8000-0000000000a1'),  -- drift: active membership, no user_tenants, no primary
  ('I',   '05466000-0000-4000-8000-0000000000a2'),  -- inactive membership, no user_tenants
  ('S',   '05466000-0000-4000-8000-0000000000a3'),  -- registered service/automation account
  ('E',   '05466000-0000-4000-8000-0000000000a4'),  -- already in both stores
  ('C',   '05466000-0000-4000-8000-0000000000a5'),  -- control: unsuppressed primary insert
  ('BOT', '00000000-0000-0000-0000-000000000001');  -- Vitana bot (lib/vitana-bot.ts:9)

CREATE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT v FROM t05466_ids WHERE k = p $$;

-- Side effects the four triggers produce for a user.
CREATE FUNCTION pg_temp.side_effects(p_user uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT (SELECT count(*) FROM public.chat_messages WHERE sender_id = p_user)
       + (SELECT count(*) FROM public.founding_members WHERE user_id = p_user)
       + (SELECT count(*) FROM public.autopilot_recommendations WHERE user_id = p_user)
       + (SELECT count(*) FROM public.live_rooms WHERE host_user_id = p_user)
$$;

DO $fx$
DECLARE r jsonb;
BEGIN
  INSERT INTO public.tenants (name, slug)
  VALUES ('VTID-05466 test tenant', 'vtid-05466-test')
  RETURNING to_jsonb(tenants.*) INTO r;
  INSERT INTO t05466_ids VALUES ('T', coalesce(r ->> 'tenant_id', r ->> 'id')::uuid);
END
$fx$;

INSERT INTO public.app_users (user_id, email, display_name)
SELECT v, 'vtid05466-' || lower(k) || '@vitanatest.exafy.io', 'VTID-05466 ' || k
  FROM t05466_ids WHERE k IN ('A', 'I', 'S', 'E', 'C', 'BOT')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.service_bot_accounts (user_id, label, reason)
VALUES (pg_temp.id('S'), 'vtid-05466-test', 'VTID-05466 pgTAP fixture')
ON CONFLICT (user_id) DO NOTHING;

-- E already has its primary membership (inserted silently, as a fix-up would).
SELECT set_config('vitana.suppress_membership_side_effects', 'on', true);
INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
VALUES (pg_temp.id('T'), pg_temp.id('E'), 'community', true);
SELECT set_config('vitana.suppress_membership_side_effects', '', true);

INSERT INTO public.memberships (user_id, tenant_id, role, status) VALUES
  (pg_temp.id('A'),   pg_temp.id('T'), 'professional', 'active'),
  (pg_temp.id('I'),   pg_temp.id('T'), 'community',    'inactive'),
  (pg_temp.id('S'),   pg_temp.id('T'), 'community',    'active'),
  (pg_temp.id('E'),   pg_temp.id('T'), 'community',    'active'),
  (pg_temp.id('BOT'), pg_temp.id('T'), 'community',    'active')
ON CONFLICT (user_id, tenant_id) DO NOTHING;

CREATE TEMP TABLE t05466_before AS
SELECT k, pg_temp.side_effects(v) AS n FROM t05466_ids WHERE k <> 'T';

-- The backfill ----------------------------------------------------------------------------------
SELECT is(public.mt_backfill_memberships_to_user_tenants(), 1,
  'the backfill inserts exactly the one drifted active, non-bot membership');

SELECT is((SELECT count(*)::int FROM public.user_tenants WHERE user_id = pg_temp.id('A') AND tenant_id = pg_temp.id('T')), 1,
  'A now has its user_tenants row');
SELECT ok((SELECT is_primary FROM public.user_tenants WHERE user_id = pg_temp.id('A') AND tenant_id = pg_temp.id('T')),
  'A had no primary membership, so the backfilled row is primary');
SELECT is((SELECT active_role FROM public.user_tenants WHERE user_id = pg_temp.id('A') AND tenant_id = pg_temp.id('T')), 'community',
  'memberships.role (a grant) never becomes the selected role: active_role is community');

-- N1: none of the four triggers fired for the backfilled primary row.
SELECT is((SELECT count(*)::int FROM public.chat_messages WHERE sender_id = pg_temp.id('A')), 0, 'backfill: 0 welcome chats');
SELECT is((SELECT count(*)::int FROM public.founding_members WHERE user_id = pg_temp.id('A')), 0, 'backfill: 0 founding seats');
SELECT is((SELECT count(*)::int FROM public.autopilot_recommendations WHERE user_id = pg_temp.id('A')), 0, 'backfill: 0 autopilot rows');
SELECT is((SELECT count(*)::int FROM public.live_rooms WHERE host_user_id = pg_temp.id('A')), 0, 'backfill: 0 live rooms');
SELECT ok((SELECT welcome_chat_sent FROM public.app_users WHERE user_id = pg_temp.id('A')),
  'welcome_chat_sent is set, so no later primary insert sends an intro DM for the backfill');
SELECT ok(NOT public.membership_side_effects_suppressed(),
  'the suppression setting is back off after the backfill');
SELECT is((SELECT count(*)::int FROM legacy_archive.bak_05466_backfill_log_20261102 WHERE user_id = pg_temp.id('A')), 1,
  'the inserted row is logged for the rollback');

-- Excluded users.
SELECT is((SELECT count(*)::int FROM public.user_tenants WHERE user_id = pg_temp.id('I') AND tenant_id = pg_temp.id('T')), 0,
  'an inactive membership is never backfilled');
SELECT is((SELECT count(*)::int FROM public.user_tenants WHERE user_id = pg_temp.id('S') AND tenant_id = pg_temp.id('T')), 0,
  'a service_bot_accounts user is never backfilled');
SELECT is((SELECT count(*)::int FROM public.user_tenants WHERE user_id = pg_temp.id('BOT') AND tenant_id = pg_temp.id('T')), 0,
  'the bot user …0001 is never backfilled');
SELECT is(pg_temp.side_effects(pg_temp.id('BOT')), (SELECT n FROM t05466_before WHERE k = 'BOT'),
  'a bot memberships insert plus the backfill yields 0 new chat_messages (and no other side effect)');
SELECT is((SELECT count(*)::int FROM legacy_archive.bak_05466_backfill_log_20261102 l
            WHERE l.user_id = pg_temp.id('BOT') OR l.user_id IN (SELECT user_id FROM public.service_bot_accounts)), 0,
  'the backfill log holds no bot or service account');

-- Re-insert of an existing row: a no-op, nothing fires.
SELECT is(public.mt_backfill_memberships_to_user_tenants(), 0, 'a second backfill run inserts nothing');
INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
VALUES (pg_temp.id('T'), pg_temp.id('E'), 'community', true)
ON CONFLICT (tenant_id, user_id) DO NOTHING;
SELECT is((SELECT count(*)::int FROM public.user_tenants WHERE user_id = pg_temp.id('E')), 1,
  're-inserting an existing membership adds no row');
SELECT is(pg_temp.side_effects(pg_temp.id('E')), (SELECT n FROM t05466_before WHERE k = 'E'),
  're-inserting an existing membership fires none of the four side effects');
SELECT is(pg_temp.side_effects(pg_temp.id('A')), (SELECT n FROM t05466_before WHERE k = 'A'),
  'the second run fires nothing for A either');

-- Positive control: the triggers are armed, so the zeros above are not vacuous.
INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
VALUES (pg_temp.id('T'), pg_temp.id('C'), 'community', true);
SELECT ok(pg_temp.side_effects(pg_temp.id('C')) > (SELECT n FROM t05466_before WHERE k = 'C'),
  'control: an unsuppressed primary insert does fire the side-effect triggers');

-- Members cannot run the backfill or write the membership tables (VTID-05147 AC-5).
SELECT ok(NOT has_function_privilege('authenticated', 'public.mt_backfill_memberships_to_user_tenants()', 'EXECUTE'),
  'authenticated cannot execute the backfill');
SELECT ok(NOT has_function_privilege('anon', 'public.mt_backfill_memberships_to_user_tenants()', 'EXECUTE'),
  'anon cannot execute the backfill');
SELECT ok(NOT has_table_privilege('authenticated', 'public.user_tenants', 'INSERT')
          AND NOT has_table_privilege('authenticated', 'public.user_tenants', 'UPDATE')
          AND NOT has_table_privilege('authenticated', 'public.user_tenants', 'DELETE'),
  'authenticated still has no write grant on user_tenants');

SELECT * FROM finish();
ROLLBACK;
