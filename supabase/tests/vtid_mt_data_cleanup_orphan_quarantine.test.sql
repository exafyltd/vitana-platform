-- VTID-05571 (mt-data-cleanup-r2 / orphan-analysis-and-quarantine) — pgTAP: orphan analysis, snapshot, remap,
-- quarantine and rollback (tasks O1-O5, O7).
-- Runs with `supabase test db` (pg_prove) on the local stack, after every migration including
-- 20261102040000..20261102040200_vtid_05571_*.sql. The apply file (040300) is a thin caller of the same functions,
-- so this test drives mt_orphan_snapshot_all() / mt_orphan_cleanup_run() / mt_orphan_restore() directly. One
-- transaction, rolled back at the end: it never runs against a shared or live database.
--
-- Covers:
--  * analyze_orphan_rows() is STABLE (cannot write), writes nothing, splits ...0001 as dev tenant from ...0001 as bot;
--  * nothing here is executable by anon/authenticated; the move refuses rows that are not snapshotted;
--  * dev user ...0099 rows (also in a live tenant) land in mt_orphan_quarantine and in no live tenant;
--  * a bot-sent row with a real tenant is untouched; a bot row with tenant ...0001 -> quarantine
--    bot_sender_dev_tenant (R3-F1), not recipient-derived;
--  * a single-membership owner is remapped (incl. the fake 550e8400 tenant); 0 and 2+ membership owners and an
--    unattributable cross-tenant DM go to quarantine and never to a live tenant;
--  * the re-pollution check (rows with tenant ...0001 per table) reads 0 after the move; a second run is a no-op;
--  * a row that cannot move is kept and recorded as move_blocked;
--  * rollback restores the snapshot row for row and clears the lane's quarantine rows.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(50);

-- Fixture ---------------------------------------------------------------------------------------
CREATE TEMP TABLE t05571_ids (k text PRIMARY KEY, v uuid NOT NULL);
INSERT INTO t05571_ids VALUES
  ('U1',  '05571000-0000-4000-8000-0000000000a1'),  -- exactly one membership (TA)
  ('U1B', '05571000-0000-4000-8000-0000000000a2'),  -- second member of TA
  ('U0',  '05571000-0000-4000-8000-0000000000a3'),  -- no membership
  ('U2',  '05571000-0000-4000-8000-0000000000a4'),  -- two memberships (TA, TB)
  ('UC',  '05571000-0000-4000-8000-0000000000a5'),  -- one membership (TB)
  ('DEV', '00000000-0000-0000-0000-000000000099'),  -- dev test user
  ('BOT', '00000000-0000-0000-0000-000000000001'),  -- Vitana bot user (also the dead dev tenant id)
  ('D1',  '05571000-0000-4000-8000-0000000000d1'),  -- row ids below
  ('F1',  '05571000-0000-4000-8000-0000000000f1'),
  ('F2',  '05571000-0000-4000-8000-0000000000f2'),
  ('F3',  '05571000-0000-4000-8000-0000000000f3'),
  ('F4',  '05571000-0000-4000-8000-0000000000f4'),
  ('F5',  '05571000-0000-4000-8000-0000000000f5'),
  ('F6',  '05571000-0000-4000-8000-0000000000f6'),
  ('C1',  '05571000-0000-4000-8000-0000000000c1'),
  ('C2',  '05571000-0000-4000-8000-0000000000c2'),
  ('C3',  '05571000-0000-4000-8000-0000000000c3'),
  ('C4',  '05571000-0000-4000-8000-0000000000c4'),
  ('C5',  '05571000-0000-4000-8000-0000000000c5'),
  ('C6',  '05571000-0000-4000-8000-0000000000c6'),
  ('G1',  '05571000-0000-4000-8000-0000000000b1'),  -- a chat group id
  ('N1',  '05571000-0000-4000-8000-0000000000e1'),
  ('FAKE','550e8400-e29b-41d4-a716-446655440000'),
  ('DEVT','00000000-0000-0000-0000-000000000001');

CREATE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT v FROM t05571_ids WHERE k = p $$;

DO $fx$
DECLARE r jsonb;
BEGIN
  INSERT INTO public.tenants (name, slug) VALUES ('VTID-05571 tenant A', 'vtid-05571-a') RETURNING to_jsonb(tenants.*) INTO r;
  INSERT INTO t05571_ids VALUES ('TA', coalesce(r ->> 'tenant_id', r ->> 'id')::uuid);
  INSERT INTO public.tenants (name, slug) VALUES ('VTID-05571 tenant B', 'vtid-05571-b') RETURNING to_jsonb(tenants.*) INTO r;
  INSERT INTO t05571_ids VALUES ('TB', coalesce(r ->> 'tenant_id', r ->> 'id')::uuid);
END
$fx$;

-- Membership rows: the primary-membership side-effect triggers stay silent (as in the 05466 tests).
SELECT set_config('vitana.suppress_membership_side_effects', 'on', true);

INSERT INTO public.app_users (user_id, email, display_name)
SELECT v, 'vtid05571-' || lower(k) || '@vitanatest.exafy.io', 'VTID-05571 ' || k
  FROM t05571_ids WHERE k IN ('U1', 'U1B', 'U0', 'U2', 'UC')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES
  (pg_temp.id('TA'), pg_temp.id('U1'),  true),
  (pg_temp.id('TA'), pg_temp.id('U1B'), true),
  (pg_temp.id('TA'), pg_temp.id('U2'),  true),
  (pg_temp.id('TB'), pg_temp.id('U2'),  false),
  (pg_temp.id('TB'), pg_temp.id('UC'),  true);

-- memory_facts: F1 dev user on the dead tenant, F6 dev user in a LIVE tenant, F2 single membership, F3 none, F4 two,
-- F5 a good row in a live tenant.
INSERT INTO public.memory_facts (id, tenant_id, user_id, fact_key, fact_value) VALUES
  (pg_temp.id('F1'), pg_temp.id('DEVT'), pg_temp.id('DEV'), 'k', 'dev'),
  (pg_temp.id('F2'), pg_temp.id('DEVT'), pg_temp.id('U1'),  'k', 'single'),
  (pg_temp.id('F3'), pg_temp.id('DEVT'), pg_temp.id('U0'),  'k', 'none'),
  (pg_temp.id('F4'), pg_temp.id('DEVT'), pg_temp.id('U2'),  'k', 'two'),
  (pg_temp.id('F5'), pg_temp.id('TA'),   pg_temp.id('U1'),  'k2', 'good'),
  (pg_temp.id('F6'), pg_temp.id('TA'),   pg_temp.id('DEV'), 'k3', 'dev in live tenant');

-- chat_messages: C1 bot on the dead tenant, C2 bot with a real tenant, C3 DM to a member of another tenant,
-- C4 DM to the bot, C5 DM inside the owner's tenant, C6 a group message (receiver_id NULL, group_id set) on the
-- dead tenant: a group message is not a DM, so it follows the sender's single-membership remap (never NULL tenant).
INSERT INTO public.chat_messages (id, tenant_id, sender_id, receiver_id, content) VALUES
  (pg_temp.id('C1'), pg_temp.id('DEVT'), pg_temp.id('BOT'), pg_temp.id('U1'),  'bot on dev tenant'),
  (pg_temp.id('C2'), pg_temp.id('TA'),   pg_temp.id('BOT'), pg_temp.id('U1'),  'bot with real tenant'),
  (pg_temp.id('C3'), pg_temp.id('DEVT'), pg_temp.id('U1'),  pg_temp.id('UC'),  'cross-tenant dm'),
  (pg_temp.id('C4'), pg_temp.id('DEVT'), pg_temp.id('U1'),  pg_temp.id('BOT'), 'dm to bot'),
  (pg_temp.id('C5'), pg_temp.id('DEVT'), pg_temp.id('U1'),  pg_temp.id('U1B'), 'dm in tenant');
INSERT INTO public.chat_messages (id, tenant_id, sender_id, receiver_id, group_id, content) VALUES
  (pg_temp.id('C6'), pg_temp.id('DEVT'), pg_temp.id('U1'),  NULL, pg_temp.id('G1'), 'group message on dev tenant');

-- user_notifications: N1 under the fake 550e8400 tenant.
INSERT INTO public.user_notifications (id, user_id, tenant_id, type, title)
VALUES (pg_temp.id('N1'), pg_temp.id('U1'), pg_temp.id('FAKE'), 'test', 'vtid-05571');

-- Helper: the fixture's own memory_facts / chat_messages / user_notifications rows by id.
CREATE FUNCTION pg_temp.q_reason(p_table text, p_id uuid) RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT reason FROM public.mt_orphan_quarantine WHERE source_table = p_table AND source_pk = p_id::text AND quarantined_by = 'VTID-05571' $$;
CREATE FUNCTION pg_temp.live_ids() RETURNS uuid[] LANGUAGE sql STABLE AS
  $$ SELECT ARRAY[pg_temp.id('TA'), pg_temp.id('TB')] $$;
CREATE FUNCTION pg_temp.fixture_total() RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT (SELECT count(*) FROM public.memory_facts) + (SELECT count(*) FROM public.chat_messages)
       + (SELECT count(*) FROM public.user_notifications) + (SELECT count(*) FROM public.mt_orphan_quarantine) $$;

-- O1: the analysis ------------------------------------------------------------------------------
SELECT is((SELECT p.provolatile::text FROM pg_proc p WHERE p.oid = 'public.analyze_orphan_rows()'::regprocedure), 's',
  'analyze_orphan_rows() is STABLE, so PostgreSQL itself rejects any write from it');

CREATE TEMP TABLE t05571_before AS SELECT pg_temp.fixture_total() AS n;
CREATE TEMP TABLE t05571_analysis AS SELECT * FROM public.analyze_orphan_rows();

SELECT is(pg_temp.fixture_total(), (SELECT n FROM t05571_before), 'analyze_orphan_rows() changed no row anywhere');
SELECT is((SELECT row_count FROM t05571_analysis WHERE table_name = 'memory_facts' AND tenant_class = 'dev_0001'
            AND owner_class = 'dev_0099' AND decision = 'dev_user_test_data'), 1::bigint,
  'dev user on the dead tenant is reported as dev_0099 / dev_user_test_data');
SELECT is((SELECT row_count FROM t05571_analysis WHERE table_name = 'memory_facts' AND tenant_class = 'live'
            AND owner_class = 'dev_0099' AND decision = 'dev_user_test_data'), 1::bigint,
  'dev user in a live tenant is reported too');
SELECT is((SELECT row_count FROM t05571_analysis WHERE table_name = 'chat_messages' AND tenant_class = 'dev_0001'
            AND owner_class = 'bot_0001' AND decision = 'bot_sender_dev_tenant'), 1::bigint,
  '...0001 as bot sender on tenant ...0001 is split from ...0001 as tenant (R3-F1)');
SELECT is((SELECT row_count FROM t05571_analysis WHERE table_name = 'chat_messages' AND tenant_class = 'live'
            AND owner_class = 'bot_0001' AND decision = 'keep'), 1::bigint,
  'a bot-sent row with a real tenant is reported as keep');
SELECT is((SELECT row_count FROM t05571_analysis WHERE table_name = 'user_notifications' AND tenant_class = 'nonexistent_550e8400'), 1::bigint,
  'the fake 550e8400 tenant is its own class');
SELECT is((SELECT count(DISTINCT table_name) FROM t05571_analysis), (SELECT count(*) FROM public.mt_orphan_registry()),
  'every registry table is listed, present or absent');

SELECT ok(NOT has_function_privilege('anon', 'public.analyze_orphan_rows()', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.analyze_orphan_rows()', 'EXECUTE')
      AND has_function_privilege('service_role', 'public.analyze_orphan_rows()', 'EXECUTE'),
  'analyze_orphan_rows(): service_role only');
SELECT ok(NOT has_function_privilege('authenticated', 'public.mt_orphan_snapshot_all()', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.mt_orphan_cleanup_run(integer)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.mt_orphan_cleanup_batch(text, integer)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.mt_orphan_restore()', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.mt_orphan_cleanup_run(integer)', 'EXECUTE'),
  'the move, snapshot and restore functions are not executable by anon/authenticated');
SELECT ok(NOT has_table_privilege('authenticated', 'public.mt_orphan_quarantine', 'SELECT')
      AND NOT has_table_privilege('anon', 'public.mt_orphan_quarantine', 'SELECT')
      AND has_table_privilege('service_role', 'public.mt_orphan_quarantine', 'SELECT')
      AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.mt_orphan_quarantine'::regclass),
  'mt_orphan_quarantine: RLS on, service_role only');
SELECT ok(NOT has_table_privilege('authenticated', 'public.bak_mt_data_cleanup_chat_messages', 'SELECT')
      AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.bak_mt_data_cleanup_chat_messages'::regclass),
  'bak_mt_data_cleanup_*: RLS on, not readable by authenticated');

-- O2: snapshot comes first ------------------------------------------------------------------------
SELECT throws_ok($$ SELECT public.mt_orphan_cleanup_batch('memory_facts', 100) $$, '55000', NULL,
  'the move refuses rows that are not in the bak_* snapshot yet');
SELECT is((SELECT count(*) FROM public.memory_facts WHERE id = pg_temp.id('F1')), 1::bigint, 'nothing moved before the snapshot');

CREATE TEMP TABLE t05571_snap AS SELECT * FROM public.mt_orphan_snapshot_all();
SELECT is((SELECT count(*) FROM public.bak_mt_data_cleanup_memory_facts
            WHERE id IN (pg_temp.id('F1'), pg_temp.id('F2'), pg_temp.id('F3'), pg_temp.id('F4'), pg_temp.id('F6'))), 5::bigint,
  'snapshot holds every memory_facts row that will move (F1-F4, F6)');
SELECT is((SELECT count(*) FROM public.bak_mt_data_cleanup_memory_facts WHERE id = pg_temp.id('F5')), 0::bigint,
  'snapshot does not hold the untouched live row');
SELECT is((SELECT count(*) FROM public.bak_mt_data_cleanup_chat_messages
            WHERE id IN (pg_temp.id('C1'), pg_temp.id('C3'), pg_temp.id('C4'), pg_temp.id('C5'))), 4::bigint,
  'snapshot holds the chat_messages that will move, not the bot row with a real tenant');
SELECT is((SELECT captured FROM public.mt_orphan_snapshot_all() WHERE table_name = 'memory_facts'), 0::bigint,
  'a second snapshot captures nothing new (first capture is never overwritten)');

CREATE TEMP TABLE t05571_snap_counts AS
  SELECT (SELECT count(*) FROM public.bak_mt_data_cleanup_memory_facts) AS f,
         (SELECT count(*) FROM public.bak_mt_data_cleanup_chat_messages) AS c,
         (SELECT count(*) FROM public.bak_mt_data_cleanup_user_notifications) AS n;
CREATE TEMP TABLE t05571_live_before AS
  SELECT id, tenant_id FROM public.chat_messages WHERE id = pg_temp.id('C2');

-- O4: the move -------------------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.mt_orphan_cleanup_run(2000) $$, '42501', NULL, 'authenticated cannot run the move');
RESET ROLE;

CREATE TEMP TABLE t05571_run AS SELECT public.mt_orphan_cleanup_run(2000) AS res;
SELECT is((SELECT count(*) FROM public.memory_facts WHERE user_id = pg_temp.id('DEV')), 0::bigint,
  'dev user ...0099 has no row left in memory_facts, in any tenant');
SELECT is(pg_temp.q_reason('memory_facts', pg_temp.id('F1')), 'dev_user_test_data', 'F1 (dev user, dead tenant) is in quarantine');
SELECT is(pg_temp.q_reason('memory_facts', pg_temp.id('F6')), 'dev_user_test_data', 'F6 (dev user, live tenant) is in quarantine');
SELECT is((SELECT payload ->> 'fact_value' FROM public.mt_orphan_quarantine WHERE source_pk = pg_temp.id('F1')::text), 'dev',
  'the quarantine keeps the original row in payload');
SELECT is((SELECT tenant_id FROM public.memory_facts WHERE id = pg_temp.id('F2')), pg_temp.id('TA'),
  'single-membership owner is remapped to its tenant');
SELECT is((SELECT tenant_id FROM public.memory_facts WHERE id = pg_temp.id('F5')), pg_temp.id('TA'), 'the good live row is unchanged');
SELECT is(pg_temp.q_reason('memory_facts', pg_temp.id('F3')), 'no_membership', 'owner with 0 memberships -> quarantine');
SELECT is(pg_temp.q_reason('memory_facts', pg_temp.id('F4')), 'ambiguous_membership', 'owner with 2+ memberships -> quarantine');
SELECT is((SELECT count(*) FROM public.memory_facts WHERE id IN (pg_temp.id('F1'), pg_temp.id('F3'), pg_temp.id('F4'), pg_temp.id('F6'))), 0::bigint,
  'no quarantined row is in any live tenant (never Maxina)');

SELECT is(pg_temp.q_reason('chat_messages', pg_temp.id('C1')), 'bot_sender_dev_tenant',
  'bot row with tenant ...0001 -> quarantine bot_sender_dev_tenant');
SELECT is((SELECT count(*) FROM public.chat_messages WHERE id = pg_temp.id('C1')), 0::bigint, 'and it is in no live tenant');
SELECT is((SELECT tenant_id FROM public.chat_messages WHERE id = pg_temp.id('C2')), pg_temp.id('TA'),
  'bot row with a real tenant is untouched');
SELECT is(pg_temp.q_reason('chat_messages', pg_temp.id('C3')), 'cross_tenant_dm', 'unattributable cross-tenant DM -> quarantine');
SELECT is((SELECT tenant_id FROM public.chat_messages WHERE id = pg_temp.id('C4')), pg_temp.id('TA'), 'DM to the bot -> sender tenant');
SELECT is((SELECT tenant_id FROM public.chat_messages WHERE id = pg_temp.id('C5')), pg_temp.id('TA'), 'DM inside the tenant -> sender tenant');
SELECT is((SELECT tenant_id FROM public.chat_messages WHERE id = pg_temp.id('C6')), pg_temp.id('TA'),
  'group message (receiver_id NULL) on the dead tenant -> sender tenant, not NULL and not blocked');
SELECT is((SELECT count(*) FROM public.mt_orphan_quarantine WHERE source_table = 'chat_messages' AND source_pk = pg_temp.id('C6')::text), 0::bigint,
  'the group message is neither quarantined nor move_blocked');
SELECT is((SELECT tenant_id FROM public.user_notifications WHERE id = pg_temp.id('N1')), pg_temp.id('TA'),
  'row under the fake 550e8400 tenant is remapped to the owner''s tenant');

-- Re-pollution check (docs/validation/VTID-05571/repollution-check.sql): rows with tenant ...0001 per table read 0.
SELECT is((SELECT count(*) FROM public.memory_facts WHERE tenant_id = pg_temp.id('DEVT'))
        + (SELECT count(*) FROM public.chat_messages WHERE tenant_id = pg_temp.id('DEVT'))
        + (SELECT count(*) FROM public.user_notifications WHERE tenant_id = pg_temp.id('DEVT')), 0::bigint,
  're-pollution check: no ...0001 row left in memory_facts, chat_messages, user_notifications');
SELECT is((SELECT coalesce(sum(row_count), 0) FROM public.analyze_orphan_rows() WHERE decision IS NOT NULL AND decision <> 'keep'), 0::numeric,
  'analysis after the move: zero rows left to move in any table');
SELECT is((SELECT (res -> 0 ->> 'table') FROM t05571_run), 'memory_facts', 'the run reports per table');

-- Idempotence
SELECT is((SELECT count(*) FROM jsonb_array_elements(public.mt_orphan_cleanup_run(2000)) e
            WHERE (e ->> 'remapped')::int + (e ->> 'quarantined')::int + (e ->> 'blocked')::int > 0), 0::bigint,
  'a second run moves nothing');

-- Blocked row: a remap that would violate UNIQUE (tenant_id, user_id) is kept and recorded.
INSERT INTO public.user_personal_boundaries (tenant_id, user_id) VALUES (pg_temp.id('TA'), pg_temp.id('U1'));
INSERT INTO public.user_personal_boundaries (id, tenant_id, user_id) VALUES (pg_temp.id('D1'), pg_temp.id('DEVT'), pg_temp.id('U1'));
SELECT public.mt_orphan_snapshot('user_personal_boundaries');
SELECT public.mt_orphan_cleanup_run(2000);
SELECT is(pg_temp.q_reason('user_personal_boundaries', pg_temp.id('D1')), 'move_blocked', 'a row that cannot move is recorded as move_blocked');
SELECT is((SELECT tenant_id FROM public.user_personal_boundaries WHERE id = pg_temp.id('D1')), pg_temp.id('DEVT'),
  'and it stays in place (nothing is lost)');

-- O5: rollback restores the snapshot row for row ------------------------------------------------------
SELECT public.mt_orphan_restore();
SELECT is((SELECT count(*) FROM public.memory_facts WHERE id IN
            (pg_temp.id('F1'), pg_temp.id('F2'), pg_temp.id('F3'), pg_temp.id('F4'), pg_temp.id('F6'))), 5::bigint,
  'rollback re-inserts the quarantined memory_facts and keeps the remapped one');
SELECT is((SELECT tenant_id FROM public.memory_facts WHERE id = pg_temp.id('F2')), pg_temp.id('DEVT'),
  'rollback puts the remapped row back on its original tenant_id');
SELECT is((SELECT count(*) FROM public.chat_messages WHERE tenant_id = pg_temp.id('DEVT')), 5::bigint,
  'rollback restores the chat_messages counts (C1, C3, C4, C5, C6 back under ...0001)');
SELECT is((SELECT receiver_id IS NULL AND group_id = pg_temp.id('G1') FROM public.chat_messages WHERE id = pg_temp.id('C6')), true,
  'rollback restores the group message with receiver_id NULL and its group_id');
SELECT is((SELECT tenant_id FROM public.chat_messages WHERE id = pg_temp.id('C2')), (SELECT tenant_id FROM t05571_live_before),
  'the bot row with a real tenant is identical after rollback');
SELECT is((SELECT count(*) FROM public.mt_orphan_quarantine WHERE quarantined_by = 'VTID-05571'), 0::bigint,
  'rollback clears this lane''s quarantine rows');
SELECT is((SELECT count(*) FROM public.bak_mt_data_cleanup_memory_facts), (SELECT f FROM t05571_snap_counts),
  'the bak_* snapshot is kept after rollback');

SELECT * FROM finish();
ROLLBACK;
