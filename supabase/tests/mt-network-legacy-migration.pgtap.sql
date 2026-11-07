-- VTID-05573 (mt-network-r2/legacy-messages-migration-db) - pgTAP: snapshot bak_*, the D15 mapping of the legacy messenger
-- tables into chat_messages / chat_groups, the rule 43-45 exclusion, idempotence, the reconcile guard and the drop.
-- Runs on a throwaway Postgres after docs/validation/VTID-05573/pgtap/vtid_05573_fixture.sql, the real migrations
-- 20261102050000 (VTID-05576) and 20261102051000 (VTID-05582), and the four lane files 20261102052000..052300.
-- One transaction, rolled back at the end: never a shared or live database.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(65);

CREATE SCHEMA t05573;
CREATE FUNCTION t05573.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('05573000-0000-4000-8000-00000000' || lpad(n::text, 4, '0'))::uuid $$;
CREATE FUNCTION t05573.t(h text) RETURNS uuid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('05573000-0000-4000-8000-0000000000' || h)::uuid $$;
CREATE FUNCTION t05573.m(h text) RETURNS uuid LANGUAGE sql IMMUTABLE AS   -- a legacy message id, 3 hex digits ('f01', 'a03')
$$ SELECT ('05573000-0000-4000-8000-000000000' || h)::uuid $$;

-- ── Legacy tables retired, snapshot kept ─────────────────────────────────
SELECT ok(to_regclass('public.messages') IS NULL AND to_regclass('public.message_threads') IS NULL
  AND to_regclass('public.global_message_threads') IS NULL AND to_regclass('public.global_messages') IS NULL,
  '1 the four legacy tables are dropped');
SELECT ok(to_regclass('public.thread_participants') IS NOT NULL AND to_regclass('public.global_thread_participants') IS NOT NULL,
  '2 the two participant tables are not dropped (outside the lane''s four)');
SELECT is((SELECT count(*) FROM public.bak_messages)::int, 7, '3 bak_messages holds all 7 legacy messages');
SELECT is((SELECT count(*) FROM public.bak_message_threads)::int, 3, '4 bak_message_threads holds all 3 threads');
SELECT is((SELECT count(*) FROM public.bak_global_messages)::int, 7, '5 bak_global_messages holds all 7 messages');
SELECT is((SELECT count(*) FROM public.bak_global_message_threads)::int, 6, '6 bak_global_message_threads holds all 6 threads');
SELECT is((SELECT count(*) FROM public.bak_thread_participants)::int + (SELECT count(*) FROM public.bak_global_thread_participants)::int, 19,
  '7 both participant snapshots are complete (7 + 12 rows)');
SELECT ok((SELECT bool_and(c.relrowsecurity) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
    AND c.relname IN ('bak_messages', 'bak_message_threads', 'bak_global_messages', 'bak_global_message_threads', 'bak_thread_participants', 'bak_global_thread_participants')),
  '8 every bak_* table has row level security on');
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['bak_messages', 'bak_message_threads', 'bak_global_messages', 'bak_global_message_threads', 'bak_thread_participants', 'bak_global_thread_participants']) b,
    unnest(ARRAY['anon', 'authenticated']) r WHERE has_table_privilege(r, 'public.' || b, 'SELECT')),
  '9 anon and authenticated cannot read any bak_* table');
SELECT ok(obj_description('public.bak_global_messages'::regclass, 'pg_class') ~ 'VTID-05573.*retain until',
  '10 a bak_* table carries its 30-day retention note');

-- ── What was migrated ─────────────────────────────────────────────────────
SELECT is((SELECT count(*) FROM public.chat_messages WHERE metadata ->> 'legacy_source' IS NOT NULL)::int, 12, '11 12 legacy messages landed in chat_messages (14 minus 2 rule-43 skips)');
SELECT is((SELECT count(*) FROM public.chat_messages WHERE metadata ->> 'legacy_source' = 'messages')::int, 6, '12 6 from messages');
SELECT is((SELECT count(*) FROM public.chat_messages WHERE metadata ->> 'legacy_source' = 'global_messages')::int, 6, '13 6 from global_messages');
SELECT is((SELECT count(*) FROM public.chat_messages WHERE metadata ->> 'legacy_source' IS NULL)::int, 2, '14 the 2 pre-existing platform messages are untouched');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.chat_messages WHERE id = t05573.m('f04') OR id = t05573.m('a07')),
  '15 a message to or from a service bot / notification actor is not migrated (rule 43)');

-- D15 mapping, messages table
SELECT ok(EXISTS (SELECT 1 FROM public.chat_messages WHERE id = t05573.m('f01') AND scope = 'community' AND tenant_id = t05573.t('a1')
  AND sender_id = t05573.u(1) AND receiver_id = t05573.u(2) AND group_id IS NULL), '16 DM between members who share tenant A -> community, tenant A');
SELECT ok(EXISTS (SELECT 1 FROM public.chat_messages WHERE id = t05573.m('f02') AND scope = 'network' AND tenant_id = t05573.t('a1')
  AND sender_id = t05573.u(1) AND receiver_id = t05573.u(3)), '17 DM between members with no shared tenant (platform tenant ignored) -> network, sender context tenant');
SELECT ok(EXISTS (SELECT 1 FROM public.chat_messages WHERE id = t05573.m('f03') AND scope = 'community' AND tenant_id = t05573.t('a2')),
  '18 DM between a TB member and a TA+TB member -> community, the shared tenant TB');
SELECT ok(EXISTS (SELECT 1 FROM public.chat_messages WHERE id = t05573.m('f05') AND scope = 'community' AND tenant_id = t05573.t('a1')
  AND sender_id = t05573.u(2) AND receiver_id = t05573.u(1)), '19 a message in a two-person direct thread becomes a DM to the other participant');
SELECT ok(EXISTS (SELECT 1 FROM public.chat_messages WHERE id = t05573.m('f06') AND scope = 'community' AND tenant_id = t05573.t('a1')
  AND receiver_id IS NULL AND group_id = t05573.t('e2')), '20 a message in a tenant group thread -> community group message in the same group id');
SELECT ok(EXISTS (SELECT 1 FROM public.chat_messages WHERE id = t05573.m('f07') AND scope = 'network' AND tenant_id = t05573.t('a1')),
  '21 a sender with no tenant at all -> network, falling back to the legacy row''s tenant');

-- D15 mapping, global tables
SELECT is((SELECT count(*) FROM public.chat_messages WHERE id IN (t05573.m('a01'), t05573.m('a02')) AND scope = 'community' AND tenant_id = t05573.t('a1'))::int, 2,
  '22 global DM between two TA members -> community, tenant A (both directions)');
SELECT ok(EXISTS (SELECT 1 FROM public.chat_messages WHERE id = t05573.m('a03') AND scope = 'network' AND tenant_id = t05573.t('a2')
  AND sender_id = t05573.u(3) AND receiver_id = t05573.u(1)), '23 global DM across tenants -> network, tenant = the sender''s own context (TB)');
SELECT ok(EXISTS (SELECT 1 FROM public.chat_messages WHERE id = t05573.m('a04') AND scope = 'community' AND tenant_id = t05573.t('a1') AND group_id = t05573.t('d3')),
  '24 global group whose members all share TA -> community group message');
SELECT is((SELECT count(*) FROM public.chat_messages WHERE id IN (t05573.m('a05'), t05573.m('a06')) AND scope = 'network' AND tenant_id = t05573.t('a1') AND group_id = t05573.t('d4'))::int, 2,
  '25 global group with members that share no tenant -> network group messages, creator''s context tenant');
SELECT ok((SELECT content = 'g1 shared dm a' AND created_at = '2026-02-01 10:00+00' FROM public.chat_messages WHERE id = t05573.m('a01'))
  AND (SELECT content = 'm1 shared tenant dm' AND created_at = '2026-01-01 10:00+00' AND read_at = '2026-01-01 11:00+00' FROM public.chat_messages WHERE id = t05573.m('f01')),
  '26 text, created_at and read_at are preserved');
SELECT ok((SELECT metadata ->> 'legacy_id' = t05573.m('f01')::text AND metadata -> 'legacy_content_data' = '{"k":1}'::jsonb FROM public.chat_messages WHERE id = t05573.m('f01')),
  '27 the legacy id and content_data are kept in metadata');

-- Groups
SELECT is((SELECT count(*) FROM public.chat_groups WHERE metadata ->> 'legacy_source' IS NOT NULL)::int, 4, '28 4 legacy groups migrated (2 tenant, 2 global)');
SELECT ok(EXISTS (SELECT 1 FROM public.chat_groups WHERE id = t05573.t('e2') AND tenant_id = t05573.t('a1') AND name = 'Team A'
  AND metadata ->> 'legacy_scope' = 'community' AND created_by = t05573.u(1)), '29 tenant group e2 -> community group of tenant A, name kept');
SELECT ok(EXISTS (SELECT 1 FROM public.chat_groups WHERE id = t05573.t('d4') AND tenant_id = t05573.t('a1') AND metadata ->> 'legacy_scope' = 'network'),
  '30 cross-tenant global group d4 -> flagged legacy_scope network (the network-groups-db lane reads this), tenant = creator context');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.chat_groups WHERE id IN (t05573.t('d5'), t05573.t('d6'))), '31 a group of only service/test accounts, and an empty group, are not migrated');
SELECT is((SELECT count(*) FROM public.chat_group_members m JOIN public.chat_groups g ON g.id = m.group_id WHERE g.metadata ->> 'legacy_source' IS NOT NULL)::int, 10,
  '32 10 members migrated (3 + 1 + 3 + 3)');
SELECT ok((SELECT role FROM public.chat_group_members WHERE group_id = t05573.t('e2') AND user_id = t05573.u(2)) = 'member'
  AND (SELECT role FROM public.chat_group_members WHERE group_id = t05573.t('e2') AND user_id = t05573.u(1)) = 'admin',
  '33 legacy role moderator -> member, admin kept');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.chat_group_members WHERE group_id = t05573.t('e3') AND user_id = t05573.u(5)), '34 a service bot is not added as a group member');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.chat_group_members m JOIN public.chat_groups g ON g.id = m.group_id
    WHERE g.metadata ->> 'legacy_source' IS NOT NULL AND m.tenant_id <> g.tenant_id), '35 every migrated member row carries the group''s context tenant');

-- Invariants of the single rule (D15) and rules 43-45
SELECT is((SELECT count(*) FROM public.chat_messages c WHERE c.metadata ->> 'legacy_source' IS NOT NULL AND c.group_id IS NULL AND c.scope = 'community'
    AND NOT EXISTS (SELECT 1 FROM public.user_tenants a JOIN public.user_tenants b ON b.tenant_id = a.tenant_id
                     WHERE a.user_id = c.sender_id AND b.user_id = c.receiver_id AND a.tenant_id = c.tenant_id))::int, 0,
  '36 every community DM has both people as members of the row''s tenant');
SELECT is((SELECT count(*) FROM public.chat_messages c WHERE c.metadata ->> 'legacy_source' IS NOT NULL AND c.group_id IS NULL AND c.scope = 'network'
    AND EXISTS (SELECT 1 FROM public.user_tenants a JOIN public.user_tenants b ON b.tenant_id = a.tenant_id
                 JOIN public.tenants t ON t.tenant_id = a.tenant_id AND NOT t.is_platform
                 WHERE a.user_id = c.sender_id AND b.user_id = c.receiver_id))::int, 0,
  '37 no network DM exists between two people who share a non-platform tenant');
SELECT is((SELECT count(*) FROM public.chat_messages c WHERE c.metadata ->> 'legacy_source' IS NOT NULL
    AND (public.is_network_excluded_account(c.sender_id) OR public.is_network_excluded_account(c.receiver_id)))::int, 0,
  '38 no migrated message involves a service bot or notification test actor (rules 43-45)');
SELECT is((SELECT count(*) FROM public.chat_messages c JOIN public.tenants t ON t.tenant_id = c.tenant_id WHERE c.metadata ->> 'legacy_source' IS NOT NULL AND t.is_platform)::int, 0,
  '39 the platform tenant is never written on member content');
SELECT is((SELECT count(*) FROM public.chat_messages WHERE metadata ->> 'legacy_source' IS NOT NULL AND scope NOT IN ('community', 'network'))::int, 0,
  '40 every migrated row has a valid scope');

-- ── The functions ────────────────────────────────────────────────────────
SELECT is(public.mt_legacy_messages_migrate() -> 'messages' ->> 'migrated', '6', '41 re-running the migration reports the same classification (messages: 6 migrated)');
SELECT ok((SELECT count(*) FROM public.chat_messages WHERE metadata ->> 'legacy_source' IS NOT NULL) = 12
  AND (SELECT count(*) FROM public.chat_groups WHERE metadata ->> 'legacy_source' IS NOT NULL) = 4,
  '42 ... and adds no row (idempotent)');
SELECT ok((public.mt_legacy_messages_migrate() -> 'global_messages') = '{"total": 7, "migrated": 6, "unplaced": 0, "skipped_excluded": 1}'::jsonb
  AND (public.mt_legacy_messages_migrate() -> 'threads') = '{"dm": 3, "empty": 1, "unplaced": 0, "group_skipped": 1, "group_migrated": 4}'::jsonb,
  '43 the reconcile figures balance: 7 = 6 + 1 + 0 and 9 threads = 3 + 4 + 1 + 1 + 0');
SELECT lives_ok($$SELECT public.mt_legacy_messages_assert_ready()$$, '44 the drop guard accepts a fully reconciled migration');
INSERT INTO public.bak_messages (id, tenant_id, sender_id, recipient_id, thread_id, body) VALUES
  (t05573.m('f99'), t05573.t('a1'), NULL, NULL, NULL, 'unplaceable: no sender, no recipient, no thread');
SELECT throws_ok($$SELECT public.mt_legacy_messages_assert_ready()$$, 'P0001', '45 the drop guard refuses while a legacy row could not be placed');
SELECT ok(NOT has_function_privilege('anon', 'public.mt_legacy_messages_migrate()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.mt_legacy_messages_migrate()', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.mt_legacy_messages_migrate()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.mt_legacy_messages_assert_ready()', 'EXECUTE'),
  '46 the migration functions are service_role only');
SELECT ok((SELECT bool_and(p.prosecdef AND p.proconfig::text LIKE '%search_path%') FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('mt_legacy_messages_migrate', 'mt_legacy_messages_assert_ready', 'mt_legacy_common_tenant', 'mt_legacy_context_tenant')),
  '47 the lane functions are SECURITY DEFINER with a pinned search_path');
SELECT ok(public.mt_legacy_common_tenant(ARRAY[t05573.u(4), t05573.u(1)]) = t05573.t('a1')
  AND public.mt_legacy_common_tenant(ARRAY[t05573.u(3), t05573.u(4)]) = t05573.t('a2')
  AND public.mt_legacy_common_tenant(ARRAY[t05573.u(1), t05573.u(3)]) IS NULL,
  '48 the shared-tenant helper: shared tenant, shared non-primary, none (platform tenant ignored)');
SELECT ok(public.mt_legacy_context_tenant(t05573.u(1)) = t05573.t('a1') AND public.mt_legacy_context_tenant(t05573.u(4)) = t05573.t('a1')
  AND public.mt_legacy_context_tenant(t05573.u(8)) IS NULL, '49 the context-tenant helper picks the primary non-platform tenant, NULL when there is none');
SELECT throws_ok($$INSERT INTO public.chat_messages (tenant_id, sender_id, receiver_id, content, scope)
    VALUES ('05573000-0000-4000-8000-0000000000a1', '05573000-0000-4000-8000-000000000001', '05573000-0000-4000-8000-000000000003', 'direct network write', 'network')$$,
  '42501', '50 the scope guard of VTID-05576 still refuses a direct network write after the migration ran');

-- ── Fix attempt 1 (reviewer verdict `changes`): the drop guard, group_skipped, the platform tenant, the participant freeze ──
DELETE FROM public.bak_messages WHERE id = t05573.m('f99');
SELECT lives_ok($$SELECT public.mt_legacy_messages_assert_ready()$$, '51 the guard accepts again once the unplaceable row is gone');

-- the guard compares the live legacy tables with their snapshots (a stale snapshot must stop the drop)
CREATE TABLE public.messages (LIKE public.bak_messages INCLUDING DEFAULTS);
SELECT lives_ok($$SELECT public.mt_legacy_messages_assert_ready()$$, '52 an empty live legacy table passes the guard');
INSERT INTO public.messages SELECT * FROM public.bak_messages;
SELECT lives_ok($$SELECT public.mt_legacy_messages_assert_ready()$$, '53 a live legacy table whose rows are all identical in the snapshot passes');
INSERT INTO public.messages (id, tenant_id, sender_id, recipient_id, body)
  VALUES (t05573.m('b09'), t05573.t('a1'), t05573.u(1), t05573.u(2), 'written after the snapshot');
SELECT throws_ok($$SELECT public.mt_legacy_messages_assert_ready()$$, 'P0001', '54 a live legacy id that is absent from its snapshot stops the guard (stale snapshot)');
DELETE FROM public.messages WHERE id = t05573.m('b09');
UPDATE public.messages SET body = 'edited after the snapshot' WHERE id = t05573.m('f01');
SELECT throws_ok($$SELECT public.mt_legacy_messages_assert_ready()$$, 'P0001', '55 a live legacy row that differs from its snapshot stops the guard');
UPDATE public.messages SET body = 'm1 shared tenant dm' WHERE id = t05573.m('f01');
SELECT lives_ok($$SELECT public.mt_legacy_messages_assert_ready()$$, '56 ... and passes again once the row matches');
ALTER TABLE public.bak_global_messages RENAME TO bak_global_messages_hidden;
SELECT throws_ok($$SELECT public.mt_legacy_messages_assert_ready()$$, 'P0001', '57 a missing snapshot table while a live legacy table exists stops the guard (no silent skip)');
DROP TABLE public.messages;
SELECT ok(public.mt_legacy_messages_assert_ready() ? 'skipped', '58 with no live legacy table left, a missing snapshot is only reported as skipped (nothing to lose)');
ALTER TABLE public.bak_global_messages_hidden RENAME TO bak_global_messages;
INSERT INTO public.thread_participants (thread_id, user_id) VALUES (t05573.t('e2'), t05573.u(7));
SELECT throws_ok($$SELECT public.mt_legacy_messages_assert_ready()$$, 'P0001', '59 a live participant row that is absent from its snapshot stops the guard');
DELETE FROM public.thread_participants WHERE user_id = t05573.u(7) AND thread_id = t05573.t('e2');

-- a group with no active non-excluded member is unplaced unless a rule 43-45 account is actually involved
INSERT INTO public.bak_global_message_threads (id, created_by, name, type) VALUES (t05573.t('b2'), t05573.u(1), 'Memberless', 'group');
INSERT INTO public.bak_global_messages (id, thread_id, sender_id, body) VALUES (t05573.m('b01'), t05573.t('b2'), t05573.u(1), 'message in a group with no member rows');
SELECT ok((public.mt_legacy_messages_migrate() -> 'global_messages' ->> 'unplaced') = '1'
  AND (public.mt_legacy_messages_migrate() -> 'global_messages' ->> 'skipped_excluded') = '1'
  AND (public.mt_legacy_messages_migrate() -> 'threads' ->> 'unplaced') = '1'
  AND (public.mt_legacy_messages_migrate() -> 'threads' ->> 'group_skipped') = '1',
  '60 a memberless group whose sender is a member is unplaced; group_skipped stays 1 (only the bots-only group d5)');
SELECT throws_ok($$SELECT public.mt_legacy_messages_assert_ready()$$, 'P0001', '61 ... and the guard refuses the drop');
DELETE FROM public.bak_global_messages WHERE id = t05573.m('b01');
DELETE FROM public.bak_global_message_threads WHERE id = t05573.t('b2');

-- the legacy row's own tenant is a fallback only when it is not the platform tenant
INSERT INTO public.bak_messages (id, tenant_id, sender_id, recipient_id, thread_id, body)
  VALUES (t05573.m('b03'), t05573.t('a3'), t05573.u(8), t05573.u(1), NULL, 'dm whose only tenant is the platform');
SELECT ok((public.mt_legacy_messages_migrate() -> 'messages' ->> 'unplaced') = '1'
  AND NOT EXISTS (SELECT 1 FROM public.chat_messages WHERE id = t05573.m('b03')),
  '62 a DM with no member tenant and a platform legacy tenant is unplaced, never written with the platform tenant');
SELECT throws_ok($$SELECT public.mt_legacy_messages_assert_ready()$$, 'P0001', '63 ... and the guard refuses the drop');
DELETE FROM public.bak_messages WHERE id = t05573.m('b03');
INSERT INTO public.bak_message_threads (id, name, type, tenant_id, created_by) VALUES (t05573.t('b4'), 'Platform only', 'group', t05573.t('a3'), t05573.u(8));
INSERT INTO public.bak_thread_participants (thread_id, user_id) VALUES (t05573.t('b4'), t05573.u(8));
SELECT ok((public.mt_legacy_messages_migrate() -> 'threads' ->> 'unplaced') = '1'
  AND NOT EXISTS (SELECT 1 FROM public.chat_groups WHERE id = t05573.t('b4')),
  '64 a group whose members have no tenant and whose legacy tenant is the platform is unplaced, never written with the platform tenant');
DELETE FROM public.bak_thread_participants WHERE thread_id = t05573.t('b4');
DELETE FROM public.bak_message_threads WHERE id = t05573.t('b4');

-- the participant tables are frozen with the four legacy tables (they feed the migration)
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['thread_participants', 'global_thread_participants']) t,
      unnest(ARRAY['anon', 'authenticated', 'service_role']) r, unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
    WHERE has_table_privilege(r, 'public.' || t, p)),
  '65 the two participant tables take no write from any API role after the freeze');

SELECT * FROM finish();
ROLLBACK;
