-- VTID-05582 (mt-network-r2/network-visibility-db) - pgTAP: network_visible, messaging_preference, the rule-45
-- trigger, the client write revoke on connection_requests, and request_connection() / respond_connection().
-- Runs on a throwaway Postgres after docs/validation/VTID-05582/pgtap/vtid_05582_fixture.sql and the two lane
-- migrations 20261102051000 and 20261102051100. One transaction, rolled back at the end: never a shared or live database.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(52);

CREATE SCHEMA t05582;
GRANT USAGE ON SCHEMA t05582 TO authenticated, anon, service_role;

CREATE FUNCTION t05582.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('05582000-0000-4000-8000-00000000' || lpad(n::text, 4, '0'))::uuid $$;

-- First column of the first row of p_sql run as role p_role with auth.uid() = p_uid ('error:<SQLSTATE>' on failure).
CREATE FUNCTION t05582.val(p_role text, p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
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
CREATE FUNCTION t05582.req(p_n int, p_to int, p_scope text, p_msg text DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT t05582.val('authenticated', t05582.u(p_n),
    format('SELECT public.request_connection(%L::uuid, %L, %L)::text', t05582.u(p_to), p_scope, p_msg))
$$;
CREATE FUNCTION t05582.resp(p_n int, p_request uuid, p_accept boolean) RETURNS text LANGUAGE sql AS $$
  SELECT t05582.val('authenticated', t05582.u(p_n), format('SELECT public.respond_connection(%L::uuid, %L)', p_request, p_accept))
$$;
GRANT EXECUTE ON FUNCTION t05582.u(int), t05582.val(text, uuid, text), t05582.req(int, int, text, text),
  t05582.resp(int, uuid, boolean) TO authenticated, anon, service_role;

-- ── Columns and defaults ─────────────────────────────────────────────────
SELECT ok(EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'global_community_profiles'
  AND column_name = 'network_visible' AND data_type = 'boolean' AND is_nullable = 'NO' AND column_default = 'false'),
  '1 network_visible boolean NOT NULL DEFAULT false');
SELECT ok(EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'global_community_profiles'
  AND column_name = 'network_visible_decided_at' AND is_nullable = 'YES'), '2 network_visible_decided_at exists and is nullable');
SELECT ok(EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'global_community_profiles'
  AND column_name = 'messaging_preference' AND is_nullable = 'NO' AND column_default LIKE '''connections''%'),
  '3 messaging_preference NOT NULL DEFAULT connections');
SELECT is((SELECT count(*) FROM public.global_community_profiles WHERE network_visible)::int, 0, '4 every pre-existing profile backfilled to network_visible = false');
SELECT is((SELECT count(*) FROM public.global_community_profiles WHERE messaging_preference = 'connections')::int, 7, '5 every pre-existing profile has messaging_preference = connections');
SELECT is(t05582.val('service_role', NULL, format('UPDATE public.global_community_profiles SET messaging_preference = %L WHERE user_id = %L RETURNING user_id::text', 'bogus', t05582.u(1))),
  'error:23514', '6 messaging_preference outside everyone/connections/nobody is rejected');
SELECT is(t05582.val('service_role', NULL, format('UPDATE public.global_community_profiles SET messaging_preference = %L WHERE user_id = %L RETURNING messaging_preference', 'everyone', t05582.u(2))),
  'everyone', '7 messaging_preference accepts everyone');

-- ── Rule-45 trigger (rules 43-45) ───────────────────────────────────────
SELECT is(t05582.val('service_role', NULL, format('UPDATE public.global_community_profiles SET network_visible = true WHERE user_id = %L RETURNING network_visible::text', t05582.u(5))),
  'false', '8 a service_bot_accounts member cannot be set network_visible = true');
SELECT is(t05582.val('service_role', NULL, format('UPDATE public.global_community_profiles SET network_visible = true WHERE user_id = %L RETURNING network_visible::text', t05582.u(6))),
  'false', '9 a notification_test_actors member cannot be set network_visible = true');
SELECT is(t05582.val('service_role', NULL, format('UPDATE public.global_community_profiles SET network_visible = true WHERE user_id = %L RETURNING network_visible::text', t05582.u(7))),
  'false', '10 a platform_only_accounts member cannot be set network_visible = true');
INSERT INTO auth.users (id, email) VALUES (t05582.u(9), 'u9@example.test');
INSERT INTO public.service_bot_accounts (user_id) VALUES (t05582.u(9));
SELECT is(t05582.val('service_role', NULL, format('INSERT INTO public.global_community_profiles (user_id, display_name, network_visible) VALUES (%L, %L, true) RETURNING network_visible::text', t05582.u(9), 'Bot')),
  'false', '11 an INSERT for a listed account lands network_visible = false');
SELECT is(t05582.val('authenticated', t05582.u(1), format('UPDATE public.global_community_profiles SET network_visible = true WHERE user_id = %L RETURNING network_visible::text', t05582.u(1))),
  'true', '12 a real member can opt in on their own row');
SELECT ok((SELECT network_visible_decided_at IS NOT NULL FROM public.global_community_profiles WHERE user_id = t05582.u(1)), '13 opting in stamps network_visible_decided_at');
UPDATE public.global_community_profiles SET network_visible_decided_at = '2000-01-01' WHERE user_id = t05582.u(1);
SELECT ok((SELECT network_visible_decided_at > '2001-01-01' FROM public.global_community_profiles WHERE user_id = t05582.u(1)), '14 a client cannot back-date network_visible_decided_at');
SELECT is(t05582.val('authenticated', t05582.u(2), format('UPDATE public.global_community_profiles SET network_visible = true WHERE user_id = %L RETURNING user_id::text', t05582.u(1))),
  NULL, '15 a member cannot change another member''s network_visible');
SELECT is(t05582.val('authenticated', t05582.u(3), format('UPDATE public.global_community_profiles SET network_visible = true WHERE user_id = %L RETURNING network_visible::text', t05582.u(3))),
  'true', '16 second real member opts in (U3)');
SELECT ok(NOT has_function_privilege('authenticated', 'public.is_network_excluded_account(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.is_network_excluded_account(uuid)', 'EXECUTE'), '17 clients cannot enumerate excluded accounts');

-- ── Client writes on connection_requests are revoked ─────────────────────
SELECT ok(NOT has_table_privilege('authenticated', 'public.connection_requests', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.connection_requests', 'UPDATE'), '18 authenticated has no INSERT or UPDATE privilege');
SELECT ok(NOT has_table_privilege('anon', 'public.connection_requests', 'INSERT')
  AND NOT has_table_privilege('anon', 'public.connection_requests', 'UPDATE'), '19 anon has no INSERT or UPDATE privilege');
SELECT ok(NOT has_any_column_privilege('authenticated', 'public.connection_requests', 'INSERT')
  AND NOT has_any_column_privilege('authenticated', 'public.connection_requests', 'UPDATE'), '20 no column-level INSERT or UPDATE privilege remains');
SELECT is(t05582.val('authenticated', t05582.u(1), format('INSERT INTO public.connection_requests (from_user_id, to_user_id, status) VALUES (%L, %L, %L) RETURNING id::text', t05582.u(1), t05582.u(2), 'accepted')),
  'error:42501', '21 a self-inserted accepted connection fails');
SELECT is(t05582.val('authenticated', t05582.u(1), format('INSERT INTO public.connection_requests (from_user_id, to_user_id) VALUES (%L, %L) RETURNING id::text', t05582.u(1), t05582.u(2))),
  'error:42501', '22 a plain client INSERT of a pending request fails too');
SELECT ok(has_table_privilege('authenticated', 'public.connection_requests', 'SELECT'), '23 authenticated can still SELECT (RLS limits it to own rows)');
SELECT ok(has_table_privilege('service_role', 'public.connection_requests', 'INSERT'), '24 service_role keeps its privileges');

-- ── request_connection() ────────────────────────────────────────────────
SELECT ok((SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public.request_connection(uuid,text,text)'::regprocedure)
  AND (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public.respond_connection(uuid,boolean)'::regprocedure), '25 both RPCs are SECURITY DEFINER');
SELECT ok((SELECT coalesce(p.proconfig::text LIKE '%search_path%', false) FROM pg_proc p WHERE p.oid = 'public.request_connection(uuid,text,text)'::regprocedure)
  AND (SELECT coalesce(p.proconfig::text LIKE '%search_path%', false) FROM pg_proc p WHERE p.oid = 'public.respond_connection(uuid,boolean)'::regprocedure), '26 both RPCs pin search_path');
SELECT ok(has_function_privilege('authenticated', 'public.request_connection(uuid,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.request_connection(uuid,text,text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.respond_connection(uuid,boolean)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.respond_connection(uuid,boolean)', 'EXECUTE'), '27 EXECUTE: authenticated yes, anon no');
SELECT is(t05582.val('authenticated', NULL, format('SELECT public.request_connection(%L::uuid, %L, NULL)::text', t05582.u(2), 'community')), 'error:28000', '28 no auth.uid() is refused');
SELECT is(t05582.req(1, 1, 'community'), 'error:22023', '29 a request to yourself is refused');
SELECT is(t05582.req(1, 2, 'galaxy'), 'error:22023', '30 an unknown scope is refused');
SELECT is(t05582.req(1, 3, 'community'), 'error:42501', '31 community needs a shared tenant: U1 and U3 share only the platform tenant');
CREATE TEMP TABLE t_ids (k text PRIMARY KEY, v text);
GRANT ALL ON t_ids TO authenticated, anon, service_role;
INSERT INTO t_ids VALUES ('c12', t05582.req(1, 2, 'community', repeat('x', 600)));
SELECT ok((SELECT v FROM t_ids WHERE k = 'c12') ~ '^[0-9a-f-]{36}$', '32 community request U1 -> U2 (shared tenant TA) returns the request id');
SELECT is((SELECT from_user_id FROM public.connection_requests WHERE id = (SELECT v::uuid FROM t_ids WHERE k = 'c12')), t05582.u(1), '33 the sender is bound to auth.uid()');
SELECT is((SELECT length(message) FROM public.connection_requests WHERE id = (SELECT v::uuid FROM t_ids WHERE k = 'c12')), 500, '34 a community message is capped at 500 characters');
SELECT is((SELECT status || '/' || request_type FROM public.connection_requests WHERE id = (SELECT v::uuid FROM t_ids WHERE k = 'c12')), 'pending/normal', '35 the new request is pending / normal');
SELECT is(t05582.req(1, 2, 'community'), (SELECT v FROM t_ids WHERE k = 'c12'), '36 a repeated request returns the same id (idempotent)');
SELECT is((SELECT count(*) FROM public.connection_requests WHERE from_user_id = t05582.u(1) AND to_user_id = t05582.u(2))::int, 1, '37 and no second row is written');
INSERT INTO t_ids VALUES ('c24', t05582.req(2, 4, 'community'));
SELECT is((SELECT v FROM t_ids WHERE k = 'c24'), (SELECT id::text FROM public.connection_requests WHERE from_user_id = t05582.u(2) AND to_user_id = t05582.u(4)), '38 U2 -> U4 (shared TA) works and is findable');

-- Network scope. U1 and U3 are opted in (cases 12 and 16); U2 and U4 are not.
SELECT is(t05582.req(5, 3, 'network'), 'error:42501', '39 a listed service account cannot send a network request');
SELECT is(t05582.req(2, 3, 'network'), 'error:42501', '40 a network request from a member who is not network_visible fails');
SELECT is(t05582.req(1, 4, 'network'), 'error:42501', '41 a network request to a non-network_visible recipient fails');
UPDATE public.global_community_profiles SET messaging_preference = 'nobody' WHERE user_id = t05582.u(3);
SELECT is(t05582.req(1, 3, 'network'), 'error:42501', '42 a network request to a "nobody" recipient fails');
UPDATE public.global_community_profiles SET messaging_preference = 'connections' WHERE user_id = t05582.u(3);
INSERT INTO public.user_blocklist (tenant_id, user_id, blocked_user_id, expires_at)
  VALUES ('05582000-0000-4000-8000-0000000000a2', t05582.u(3), t05582.u(1), now() + interval '1 day');
SELECT is(t05582.req(1, 3, 'network'), 'error:42501', '43 a network request to someone who blocked the sender fails');
UPDATE public.user_blocklist SET expires_at = now() - interval '1 day';
INSERT INTO t_ids VALUES ('n13', t05582.req(1, 3, 'network', 'hello from a stranger'));
SELECT ok((SELECT v FROM t_ids WHERE k = 'n13') ~ '^[0-9a-f-]{36}$', '44 once the block has expired, the network request goes through (U1 -> U3, connections preference)');
SELECT is((SELECT message FROM public.connection_requests WHERE id = (SELECT v::uuid FROM t_ids WHERE k = 'n13')), NULL, '45 the free-text message is dropped for a network request');
-- Rate limit: 20 requests in the last 24 hours is the ceiling for a network request.
INSERT INTO auth.users (id, email) SELECT ('05582000-0000-4000-8000-00000000' || lpad(g::text, 4, '0'))::uuid, 'r' || g || '@example.test' FROM generate_series(100, 119) g;
INSERT INTO public.global_community_profiles (user_id, display_name, network_visible)
  SELECT ('05582000-0000-4000-8000-00000000' || lpad(g::text, 4, '0'))::uuid, 'R' || g, true FROM generate_series(100, 119) g;
INSERT INTO public.connection_requests (from_user_id, to_user_id)
  SELECT t05582.u(3), ('05582000-0000-4000-8000-00000000' || lpad(g::text, 4, '0'))::uuid FROM generate_series(100, 119) g;
UPDATE public.global_community_profiles SET network_visible = true WHERE user_id = t05582.u(1);
SELECT is(t05582.req(3, 1, 'network'), 'error:54000', '46 the 21st request inside 24 hours is rate limited');

-- ── respond_connection() ────────────────────────────────────────────────
SELECT is(t05582.resp(1, (SELECT v::uuid FROM t_ids WHERE k = 'c12'), true), 'error:P0002', '47 the sender cannot accept their own request');
SELECT is(t05582.resp(4, (SELECT v::uuid FROM t_ids WHERE k = 'c12'), true), 'error:P0002', '48 a third member cannot accept it');
SELECT is(t05582.resp(2, (SELECT v::uuid FROM t_ids WHERE k = 'c12'), true), 'accepted', '49 the recipient accepts');
SELECT ok((SELECT responded_at IS NOT NULL FROM public.connection_requests WHERE id = (SELECT v::uuid FROM t_ids WHERE k = 'c12')), '50 accepting stamps responded_at');
SELECT is(t05582.resp(2, (SELECT v::uuid FROM t_ids WHERE k = 'c12'), false), 'error:P0002', '51 a request that is no longer pending cannot be changed again');
SELECT is(t05582.resp(3, (SELECT v::uuid FROM t_ids WHERE k = 'n13'), false), 'declined', '52 the recipient can decline');

SELECT * FROM finish();
ROLLBACK;
