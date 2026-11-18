-- VTID-05576 (mt-network-r2/messaging-send-db) - pgTAP: chat_messages.scope, the client-write lockdown, send_message() and
-- send_message_as(). Runs on a throwaway Postgres after docs/validation/VTID-05576/pgtap/vtid_05576_fixture.sql and the three
-- lane migrations 20261102050000, 20261102050100, 20261102050200. One transaction, rolled back at the end: never a shared or
-- live database. The test inserts its own rows; it asserts on those rows only (no absolute table counts).
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(62);

CREATE SCHEMA t05576;
GRANT USAGE ON SCHEMA t05576 TO authenticated, anon, service_role;

CREATE FUNCTION t05576.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('05576000-0000-4000-8000-00000000' || lpad(n::text, 4, '0'))::uuid $$;

-- First column of the first row of p_sql run as role p_role with auth.uid() = p_uid ('error:<SQLSTATE>' on failure).
CREATE FUNCTION t05576.val(p_role text, p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
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
-- send_message as member p_n (authenticated, auth.uid() = p_n): id of the new row, or 'error:<SQLSTATE>'.
CREATE FUNCTION t05576.snd(p_n int, p_peer uuid, p_scope text, p_body text DEFAULT 'hello', p_cmid uuid DEFAULT NULL, p_group uuid DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT t05576.val('authenticated', t05576.u(p_n), format('SELECT id::text FROM public.send_message(%L::uuid, %L::uuid, %L, %L, ''text'', ''{}''::jsonb, %L::uuid)', p_peer, p_group, p_scope, p_body, p_cmid))
$$;
-- send_message_as as the gateway (service_role) on behalf of sender p_sender.
CREATE FUNCTION t05576.snda(p_sender uuid, p_peer uuid, p_scope text, p_body text DEFAULT 'hello') RETURNS text LANGUAGE sql AS $$
  SELECT t05576.val('service_role', NULL, format('SELECT id::text FROM public.send_message_as(%L::uuid, %L::uuid, NULL::uuid, %L, %L, ''text'', ''{}''::jsonb, NULL::uuid)', p_sender, p_peer, p_scope, p_body))
$$;
GRANT EXECUTE ON FUNCTION t05576.u(int), t05576.val(text, uuid, text), t05576.snd(int, uuid, text, text, uuid, uuid),
  t05576.snda(uuid, uuid, text, text) TO authenticated, anon, service_role;

-- ── Task 1: scope column, expand then contract ───────────────────────────
SELECT ok(EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'chat_messages'
  AND column_name = 'scope' AND data_type = 'text' AND is_nullable = 'NO' AND column_default IS NULL),
  '1 chat_messages.scope text NOT NULL with the migration default dropped');
SELECT ok((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.chat_messages'::regclass AND conname = 'chat_messages_scope_check')
  ~ 'community.*network', '2 a CHECK limits scope to community and network');
SELECT is((SELECT scope FROM public.chat_messages WHERE id = '05576000-0000-4000-8000-0000000000c1'), 'community',
  '3 a pre-existing DM was backfilled to community');
SELECT is((SELECT scope FROM public.chat_messages WHERE id = '05576000-0000-4000-8000-0000000000c2'), 'community',
  '4 a pre-existing group message was backfilled to community');
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.chat_messages'::regclass AND tgname = 'trg_chat_messages_scope_guard' AND NOT tgisinternal),
  '5 the scope guard trigger exists on chat_messages');

-- ── Task 3 + 5: client and direct writes ─────────────────────────────────
SELECT is(t05576.val('authenticated', t05576.u(1), format('INSERT INTO public.chat_messages (tenant_id, sender_id, receiver_id, content, scope) VALUES (%L, %L, %L, ''x'', ''community'') RETURNING id::text',
  '05576000-0000-4000-8000-0000000000a1', t05576.u(1), t05576.u(2))), 'error:42501', '6 a bare authenticated client INSERT fails (no INSERT privilege)');
SELECT is(t05576.val('anon', NULL, format('INSERT INTO public.chat_messages (tenant_id, sender_id, receiver_id, content, scope) VALUES (%L, %L, %L, ''x'', ''community'') RETURNING id::text',
  '05576000-0000-4000-8000-0000000000a1', t05576.u(1), t05576.u(2))), 'error:42501', '7 an anon INSERT fails');
SELECT is(t05576.val('service_role', NULL, format('INSERT INTO public.chat_messages (tenant_id, sender_id, receiver_id, content, scope) VALUES (%L, %L, %L, ''x'', ''network'') RETURNING id::text',
  '05576000-0000-4000-8000-0000000000a1', t05576.u(1), t05576.u(3))), 'error:42501', '8 a direct service-role INSERT of scope = network fails');
SELECT is(t05576.val('service_role', NULL, format('INSERT INTO public.chat_messages (tenant_id, sender_id, receiver_id, content) VALUES (%L, %L, %L, ''x'') RETURNING id::text',
  '05576000-0000-4000-8000-0000000000a1', t05576.u(1), t05576.u(2))), 'error:23502', '9 a direct service-role INSERT without a scope fails (no default)');
SELECT is(t05576.val('service_role', NULL, format('INSERT INTO public.chat_messages (id, tenant_id, sender_id, receiver_id, content, scope) VALUES (%L, %L, %L, %L, ''system'', ''community'') RETURNING id::text',
  '05576000-0000-4000-8000-0000000000c3', '05576000-0000-4000-8000-0000000000a1', t05576.u(1), t05576.u(2))), '05576000-0000-4000-8000-0000000000c3', '10 a system writer can still INSERT scope = community explicitly');
SELECT is(t05576.val('service_role', NULL, format('UPDATE public.chat_messages SET scope = ''network'' WHERE id = %L RETURNING id::text', '05576000-0000-4000-8000-0000000000c1')),
  'error:42501', '11 a direct service-role UPDATE of scope to network fails');
SELECT is((SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'chat_messages' AND policyname = 'service_role_manage_chat')::int, 0,
  '12 the catch-all service_role_manage_chat policy is gone');
SELECT is((SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'chat_messages' AND (cmd = 'ALL' OR qual = 'true' OR with_check = 'true'))::int, 0,
  '13 no allow-all or ALL-command policy exists on chat_messages');
SELECT is((SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'chat_messages' AND cmd = 'INSERT')::int, 0,
  '14 no INSERT policy remains on chat_messages (writes only through the RPCs and the guarded system writers)');
SELECT is((SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'chat_messages' AND cmd = 'UPDATE' AND policyname = 'chat_messages_recipient_mark_read')::int, 1,
  '15 one narrow recipient UPDATE policy exists');
SELECT is((SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'chat_messages' AND cmd = 'SELECT')::int, 2,
  '16 the SELECT policies are the participant policy and the group-member policy');
SELECT is(t05576.val('authenticated', t05576.u(2), format('UPDATE public.chat_messages SET content = ''edited'' WHERE id = %L RETURNING id::text', '05576000-0000-4000-8000-0000000000c1')),
  'error:42501', '17 a recipient cannot rewrite the content of a message');
SELECT is(t05576.val('authenticated', t05576.u(2), format('UPDATE public.chat_messages SET scope = ''network'' WHERE id = %L RETURNING id::text', '05576000-0000-4000-8000-0000000000c1')),
  'error:42501', '18 a recipient cannot change the scope of a message');
SELECT is(t05576.val('authenticated', t05576.u(2), format('UPDATE public.chat_messages SET read_at = now() WHERE id = %L RETURNING id::text', '05576000-0000-4000-8000-0000000000c1')),
  '05576000-0000-4000-8000-0000000000c1', '19 the recipient can mark a message read');
SELECT is(t05576.val('authenticated', t05576.u(1), format('WITH x AS (UPDATE public.chat_messages SET read_at = now() WHERE id = %L RETURNING id) SELECT count(*)::text FROM x', '05576000-0000-4000-8000-0000000000c3')),
  '0', '20 the sender cannot mark the recipient''s message read (row policy)');
SELECT is(t05576.val('authenticated', t05576.u(2), format('SELECT count(*)::text FROM public.chat_messages WHERE id = %L', '05576000-0000-4000-8000-0000000000c1')),
  '1', '21 a participant still reads their message');
SELECT is(t05576.val('authenticated', t05576.u(3), format('SELECT count(*)::text FROM public.chat_messages WHERE id = %L', '05576000-0000-4000-8000-0000000000c1')),
  '0', '22 a non-participant reads nothing');
SELECT is(t05576.val('authenticated', t05576.u(2), format('SELECT count(*)::text FROM public.chat_messages WHERE id = %L', '05576000-0000-4000-8000-0000000000c2')),
  '1', '23 a group member still reads the group message');

-- ── Function shape and privileges ────────────────────────────────────────
SELECT ok((SELECT bool_and(p.prosecdef AND p.proconfig::text LIKE '%search_path%') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('send_message', 'send_message_as', 'chat_send_message_core')),
  '24 all three functions are SECURITY DEFINER with a pinned search_path');
SELECT ok((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('send_message', 'send_message_as', 'chat_send_message_core')) = 3,
  '25 send_message, send_message_as and the shared core each exist once');
SELECT ok(pg_get_function_arguments('public.send_message(uuid,uuid,text,text,text,jsonb,uuid)'::regprocedure) !~ 'sender',
  '26 send_message takes no sender argument (the sender is auth.uid())');
SELECT ok(has_function_privilege('authenticated', 'public.send_message(uuid,uuid,text,text,text,jsonb,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.send_message(uuid,uuid,text,text,text,jsonb,uuid)', 'EXECUTE'),
  '27 send_message: EXECUTE for authenticated, not anon');
SELECT ok(has_function_privilege('service_role', 'public.send_message_as(uuid,uuid,uuid,text,text,text,jsonb,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.send_message_as(uuid,uuid,uuid,text,text,text,jsonb,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.send_message_as(uuid,uuid,uuid,text,text,text,jsonb,uuid)', 'EXECUTE'),
  '28 send_message_as: EXECUTE for service_role only');
SELECT ok(NOT has_function_privilege('authenticated', 'public.chat_send_message_core(uuid,uuid,uuid,text,text,text,jsonb,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.chat_send_message_core(uuid,uuid,uuid,text,text,text,jsonb,uuid)', 'EXECUTE'),
  '29 the shared core is not executable by any client role');

-- ── Argument checks ──────────────────────────────────────────────────────
SELECT is(t05576.val('anon', NULL, format('SELECT id::text FROM public.send_message(%L::uuid, NULL, ''community'', ''hi'')', t05576.u(2))), 'error:42501',
  '30 anon cannot call send_message');
SELECT is(t05576.val('authenticated', NULL, format('SELECT id::text FROM public.send_message(%L::uuid, NULL, ''community'', ''hi'')', t05576.u(2))), 'error:28000',
  '31 send_message without an authenticated user fails (28000)');
SELECT is(t05576.snd(1, t05576.u(2), 'bogus'), 'error:22023', '32 an unknown scope fails');
SELECT is(t05576.snd(1, t05576.u(2), 'community', '   '), 'error:22023', '33 an empty body fails');
SELECT is(t05576.snd(1, t05576.u(1), 'community'), 'error:22023', '34 a send to yourself fails');
SELECT is(t05576.snd(1, NULL, 'community'), 'error:22023', '35 neither a peer nor a group fails');
SELECT is(t05576.snd(1, t05576.u(2), 'community', 'hello', NULL, '05576000-0000-4000-8000-0000000000b1'), 'error:22023', '36 both a peer and a group fails');
SELECT is(t05576.snda(NULL, t05576.u(2), 'community'), 'error:28000', '37 send_message_as with no sender fails (28000)');

-- ── Task 5: community sends ──────────────────────────────────────────────
CREATE TEMP TABLE r (k text PRIMARY KEY, v text);
GRANT ALL ON r TO PUBLIC;
INSERT INTO r VALUES ('c1', t05576.snd(1, t05576.u(2), 'community', 'hi u2'));
SELECT ok((SELECT v FROM r WHERE k = 'c1') !~ '^error', '38 a community send between members of a shared tenant succeeds');
SELECT ok(EXISTS (SELECT 1 FROM public.chat_messages WHERE id::text = (SELECT v FROM r WHERE k = 'c1')
  AND sender_id = t05576.u(1) AND receiver_id = t05576.u(2) AND scope = 'community' AND tenant_id = '05576000-0000-4000-8000-0000000000a1' AND content = 'hi u2'),
  '39 the row carries sender = auth.uid(), scope = community and the shared tenant');
SELECT is(t05576.snd(1, t05576.u(3), 'community'), 'error:42501', '40 a community send with no shared tenant fails (the platform tenant does not count)');
SELECT is(t05576.snd(1, '05576000-0000-4000-8000-0000000000ff', 'community'), 'error:42501', '41 a community send to an unknown member fails');
INSERT INTO r VALUES ('c4', t05576.snd(4, t05576.u(3), 'community', 'hi u3'));
SELECT is((SELECT tenant_id::text FROM public.chat_messages WHERE id::text = (SELECT v FROM r WHERE k = 'c4')), '05576000-0000-4000-8000-0000000000a2',
  '42 the tenant is derived from the shared tenant (member 4 and 3 share only TB)');
INSERT INTO r VALUES ('i1', t05576.snd(1, t05576.u(2), 'community', 'once', '05576000-0000-4000-8000-0000000000d1'));
INSERT INTO r VALUES ('i2', t05576.snd(1, t05576.u(2), 'community', 'once', '05576000-0000-4000-8000-0000000000d1'));
SELECT ok((SELECT v FROM r WHERE k = 'i1') = (SELECT v FROM r WHERE k = 'i2')
  AND (SELECT count(*) FROM public.chat_messages WHERE client_message_id = '05576000-0000-4000-8000-0000000000d1') = 1,
  '43 a repeated client_message_id returns the stored row, no second row');
INSERT INTO r VALUES ('g1', t05576.snd(2, NULL, 'community', 'hi group', NULL, '05576000-0000-4000-8000-0000000000b1'));
SELECT ok(EXISTS (SELECT 1 FROM public.chat_messages WHERE id::text = (SELECT v FROM r WHERE k = 'g1')
  AND group_id = '05576000-0000-4000-8000-0000000000b1' AND receiver_id IS NULL AND scope = 'community' AND tenant_id = '05576000-0000-4000-8000-0000000000a1'),
  '44 a group member can send to the group; the tenant is the group''s');
SELECT is(t05576.snd(3, NULL, 'community', 'hi group', NULL, '05576000-0000-4000-8000-0000000000b1'), 'error:42501', '45 a non-member cannot send to the group');
SELECT is(t05576.snd(1, NULL, 'network', 'hi group', NULL, '05576000-0000-4000-8000-0000000000b1'), 'error:22023', '46 a network group send is not supported yet');

-- ── Task 5: network sends ────────────────────────────────────────────────
-- Members: 1 visible/everyone, 2 visible/connections, 3 visible/everyone, 4 NOT visible, 5 bot (visible by a raw write),
-- 7 visible/nobody, 8 visible/everyone. The test sets these itself.
INSERT INTO public.global_community_profiles (user_id) VALUES (t05576.u(8));
UPDATE public.global_community_profiles SET network_visible = true, messaging_preference = 'everyone' WHERE user_id IN (t05576.u(1), t05576.u(3), t05576.u(5), t05576.u(8));
UPDATE public.global_community_profiles SET network_visible = true, messaging_preference = 'connections' WHERE user_id = t05576.u(2);
UPDATE public.global_community_profiles SET network_visible = true, messaging_preference = 'nobody' WHERE user_id = t05576.u(7);
SELECT is(t05576.snd(1, t05576.u(4), 'network'), 'error:42501', '47 a network send to a recipient who is not network_visible fails');
SELECT is(t05576.snd(1, t05576.u(7), 'network'), 'error:42501', '48 a network send to a "nobody" recipient fails');
SELECT is(t05576.snd(4, t05576.u(3), 'network'), 'error:42501', '49 a network send by a sender who is not network_visible fails');
SELECT is(t05576.snda(t05576.u(1), t05576.u(4), 'network'), 'error:42501', '50 send_message_as applies the same network check');
SELECT is(t05576.snd(1, t05576.u(2), 'network'), 'error:42501', '51 a "connections" recipient without an accepted connection fails');
INSERT INTO public.connection_requests (from_user_id, to_user_id, status) VALUES (t05576.u(2), t05576.u(1), 'pending');
SELECT is(t05576.snd(1, t05576.u(2), 'network'), 'error:42501', '52 a pending connection is not enough');
UPDATE public.connection_requests SET status = 'accepted' WHERE from_user_id = t05576.u(2) AND to_user_id = t05576.u(1);
INSERT INTO r VALUES ('n2', t05576.snd(1, t05576.u(2), 'network', 'hi network'));
SELECT ok(EXISTS (SELECT 1 FROM public.chat_messages WHERE id::text = (SELECT v FROM r WHERE k = 'n2')
  AND sender_id = t05576.u(1) AND receiver_id = t05576.u(2) AND scope = 'network' AND tenant_id = '05576000-0000-4000-8000-0000000000a1'),
  '53 an accepted connection (either direction) allows it; scope = network, tenant = the sender''s primary tenant');
INSERT INTO r VALUES ('n3', t05576.snd(1, t05576.u(3), 'network', 'hi cross-tenant'));
SELECT ok((SELECT v FROM r WHERE k = 'n3') !~ '^error' AND (SELECT tenant_id::text FROM public.chat_messages WHERE id::text = (SELECT v FROM r WHERE k = 'n3')) = '05576000-0000-4000-8000-0000000000a1',
  '54 an "everyone" recipient in another tenant is reachable; the context tenant is the sender''s');
INSERT INTO public.user_blocklist (tenant_id, user_id, blocked_user_id, expires_at) VALUES ('05576000-0000-4000-8000-0000000000a2', t05576.u(3), t05576.u(1), now() + interval '1 day');
SELECT is(t05576.snd(1, t05576.u(3), 'network'), 'error:42501', '55 a block by the recipient stops a network send');
INSERT INTO public.user_blocklist (tenant_id, user_id, blocked_user_id, expires_at) VALUES ('05576000-0000-4000-8000-0000000000a1', t05576.u(1), t05576.u(8), now() + interval '1 day');
SELECT is(t05576.snd(1, t05576.u(8), 'network'), 'error:42501', '56 a block by the sender stops a network send');
UPDATE public.user_blocklist SET expires_at = now() - interval '1 day' WHERE user_id = t05576.u(1) AND blocked_user_id = t05576.u(8);
SELECT isnt(t05576.snd(1, t05576.u(8), 'network'), 'error:42501', '57 an expired block no longer stops it');
SELECT is(t05576.snd(1, t05576.u(5), 'network'), 'error:42501', '58 a service bot is never a network recipient (rule 45), even if its profile row were visible');
SELECT is(t05576.snda(t05576.u(1), t05576.u(3), 'community'), 'error:42501', '59 send_message_as community also needs a shared tenant');
INSERT INTO r VALUES ('as2', t05576.snda(t05576.u(1), t05576.u(2), 'community', 'on behalf'));
SELECT ok(EXISTS (SELECT 1 FROM public.chat_messages WHERE id::text = (SELECT v FROM r WHERE k = 'as2') AND sender_id = t05576.u(1) AND scope = 'community'),
  '60 send_message_as trusts p_sender: the row is the named member''s');

-- Rate limit: 20 new network contacts per 24 hours. The sender (member 3) already has 20 contacts, written by the test.
INSERT INTO auth.users (id, email) SELECT ('05576000-0000-4000-8000-00000000' || lpad(g::text, 4, '0'))::uuid, 'u' || g || '@example.test' FROM generate_series(11, 31) g;
INSERT INTO public.global_community_profiles (user_id, network_visible, messaging_preference)
  SELECT ('05576000-0000-4000-8000-00000000' || lpad(g::text, 4, '0'))::uuid, true, 'everyone' FROM generate_series(11, 31) g;
SET LOCAL vitana.chat_send_rpc = 'on';
INSERT INTO public.chat_messages (tenant_id, sender_id, receiver_id, content, scope)
  SELECT '05576000-0000-4000-8000-0000000000a2', t05576.u(3), t05576.u(g), 'seed', 'network' FROM generate_series(11, 30) g;
RESET vitana.chat_send_rpc;
SELECT is(t05576.snd(3, t05576.u(31), 'network'), 'error:54000', '61 the 21st new network contact in 24 hours is rate limited');
SELECT isnt(t05576.snd(3, t05576.u(11), 'network'), 'error:54000', '62 an existing contact is not a new contact and is not limited');

SELECT * FROM finish();
ROLLBACK;
