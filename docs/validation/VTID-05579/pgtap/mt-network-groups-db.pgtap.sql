-- VTID-05579 (mt-network-r2/network-groups-db) - pgTAP: chat_groups.scope / chat_group_members.scope, the legacy backfill, the
-- scope guards, participant-only RLS, create_network_group() and add_group_member() (D27: at most 20 members, invite-only between
-- connections, the creator's tenant as context, no system fan-out; rules 43-45). Runs on a throwaway Postgres after
-- docs/validation/VTID-05579/pgtap/vtid_05579_fixture.sql, the real 20261102050000 and 20261102051000, vtid_05579_fixture_data.sql
-- and the three lane migrations 20261102054000, 20261102054100, 20261102054200. One transaction, rolled back at the end: never a
-- shared or live database. The test inserts its own rows and asserts on those rows only (no absolute table counts).
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(92);

CREATE SCHEMA t05579;
GRANT USAGE ON SCHEMA t05579 TO authenticated, anon, service_role;
CREATE TEMP TABLE r (k text PRIMARY KEY, v text);
GRANT ALL ON r TO PUBLIC;

CREATE FUNCTION t05579.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('05579000-0000-4000-8000-00000000' || lpad(n::text, 4, '0'))::uuid $$;
CREATE FUNCTION t05579.g(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('05579000-0000-4000-8000-0000000000b' || n::text)::uuid $$;

-- First column of the first row of p_sql run as role p_role with auth.uid() = p_uid ('error:<SQLSTATE>:<message>' on failure).
CREATE FUNCTION t05579.val(p_role text, p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims',
    (jsonb_build_object('role', p_role) || CASE WHEN p_uid IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sub', p_uid) END)::text, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN OTHERS THEN
    v := 'error:' || SQLSTATE || ':' || SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v;
END $$;
-- True when p_sql (a SELECT of one boolean) returns true; false on any error (so a missing column reads as a red case, not a crash).
CREATE FUNCTION t05579.chk(p_sql text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE b boolean;
BEGIN
  EXECUTE p_sql INTO b;
  RETURN coalesce(b, false);
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END $$;
-- 'error:<SQLSTATE>' without the message.
CREATE FUNCTION t05579.ec(p_v text) RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT split_part(p_v, ':', 1) || ':' || split_part(p_v, ':', 2) $$;
-- The uuid stored in r under p_k, or NULL when the creation failed (so a failed creation reads as red cases, not a crash).
CREATE FUNCTION t05579.gid(p_k text) RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT CASE WHEN v ~ '^[0-9a-f-]{36}$' THEN v::uuid END FROM r WHERE k = p_k $$;
-- Run p_sql with the group-RPC transaction flag on (what the DEFINER functions do), as the calling role.
CREATE FUNCTION t05579.flag(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('vitana.chat_group_rpc', 'on', true);
  EXECUTE p_sql INTO v;
  PERFORM set_config('vitana.chat_group_rpc', '', true);
  RETURN v;
END $$;
-- create_network_group as member p_n: the new group id, or 'error:...'.
CREATE FUNCTION t05579.mk(p_n int, p_name text DEFAULT 'Netz') RETURNS text LANGUAGE sql AS $$
  SELECT t05579.val('authenticated', t05579.u(p_n), format('SELECT public.create_network_group(%L)::text', p_name)) $$;
-- add_group_member as member p_n (authenticated): 'true' | 'false' | 'error:...'.
CREATE FUNCTION t05579.add(p_n int, p_group uuid, p_m int) RETURNS text LANGUAGE sql AS $$
  SELECT t05579.val('authenticated', t05579.u(p_n), format('SELECT public.add_group_member(%L::uuid, %L::uuid)::text', p_group, t05579.u(p_m))) $$;
-- add_group_member_as as the gateway (service_role) on behalf of actor p_actor.
CREATE FUNCTION t05579.adda(p_actor uuid, p_group uuid, p_m int) RETURNS text LANGUAGE sql AS $$
  SELECT t05579.val('service_role', NULL, format('SELECT public.add_group_member_as(%L::uuid, %L::uuid, %L::uuid)::text', p_actor, p_group, t05579.u(p_m))) $$;
-- p_from..p_to added by member p_n: how many succeeded.
CREATE FUNCTION t05579.fill(p_n int, p_group uuid, p_from int, p_to int) RETURNS int LANGUAGE plpgsql AS $$
DECLARE i int; c int := 0;
BEGIN
  FOR i IN p_from..p_to LOOP
    IF t05579.add(p_n, p_group, i) = 'true' THEN c := c + 1; END IF;
  END LOOP;
  RETURN c;
END $$;
GRANT EXECUTE ON FUNCTION t05579.u(int), t05579.g(int), t05579.val(text, uuid, text), t05579.ec(text), t05579.chk(text), t05579.gid(text), t05579.flag(text),
  t05579.mk(int, text), t05579.add(int, uuid, int), t05579.adda(uuid, uuid, int), t05579.fill(int, uuid, int, int) TO authenticated, anon, service_role;

-- Rule 45 proof needs the exclusion list, not the visibility flag, to be what stops a listed account: turn the opt-in on for
-- U5/U6/U7 with the profile guard off (the guard would otherwise keep it false), then back on.
ALTER TABLE public.global_community_profiles DISABLE TRIGGER USER;
UPDATE public.global_community_profiles SET network_visible = true WHERE user_id IN (t05579.u(5), t05579.u(6), t05579.u(7));
ALTER TABLE public.global_community_profiles ENABLE TRIGGER USER;

-- ── Task 1: scope columns and the backfill from metadata.legacy_scope ─────
SELECT ok(EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'chat_groups'
  AND column_name = 'scope' AND data_type = 'text' AND is_nullable = 'NO' AND column_default LIKE '%community%'),
  '1 chat_groups.scope text NOT NULL DEFAULT community');
SELECT ok(EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'chat_group_members'
  AND column_name = 'scope' AND data_type = 'text' AND is_nullable = 'NO' AND column_default LIKE '%community%'),
  '2 chat_group_members.scope text NOT NULL DEFAULT community');
SELECT ok((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.chat_groups'::regclass AND conname = 'chat_groups_scope_check')
  ~ 'community.*network', '3 a CHECK limits chat_groups.scope to community and network');
SELECT ok((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.chat_group_members'::regclass AND conname = 'chat_group_members_scope_check')
  ~ 'community.*network', '4 a CHECK limits chat_group_members.scope to community and network');
SELECT is(t05579.val('postgres', NULL, format('SELECT scope FROM public.chat_groups WHERE id = %L', t05579.g(1))), 'network',
  '5 the legacy cross-tenant group (metadata.legacy_scope = network) is backfilled to network');
SELECT is(t05579.val('postgres', NULL, format('SELECT string_agg(DISTINCT scope, '','') FROM public.chat_group_members WHERE group_id = %L', t05579.g(1))), 'network',
  '6 its members are backfilled to network');
SELECT is(t05579.val('postgres', NULL, format('SELECT scope FROM public.chat_groups WHERE id = %L', t05579.g(2))), 'community',
  '7 a legacy group with legacy_scope = community stays community');
SELECT is(t05579.val('postgres', NULL, format('SELECT string_agg(DISTINCT scope, '','') FROM public.chat_groups WHERE id IN (%L, %L, %L)', t05579.g(3), t05579.g(4), t05579.g(5))), 'community',
  '8 the system group, an ordinary group and the big group (no legacy_scope) stay community');
SELECT is(t05579.val('postgres', NULL, format('SELECT count(*)::text FROM public.chat_group_members WHERE group_id IN (%L, %L, %L, %L) AND scope <> ''community''', t05579.g(2), t05579.g(3), t05579.g(4), t05579.g(5))), '0',
  '9 the members of every community group stay community');

-- ── Task 1: the scope guards ─────────────────────────────────────────────
SELECT is(t05579.ec(t05579.val('service_role', NULL, format('INSERT INTO public.chat_groups (tenant_id, name, scope) VALUES (%L, ''x'', ''network'') RETURNING id::text', '05579000-0000-4000-8000-0000000000a1'))), 'error:42501',
  '10 a direct service-role INSERT of a network group fails');
SELECT is(t05579.ec(t05579.val('service_role', NULL, format('UPDATE public.chat_groups SET scope = ''network'' WHERE id = %L RETURNING id::text', t05579.g(4)))), 'error:42501',
  '11 a direct service-role UPDATE of a group to network fails');
SELECT is(t05579.ec(t05579.val('service_role', NULL, format('UPDATE public.chat_groups SET scope = ''community'' WHERE id = %L RETURNING id::text', t05579.g(1)))), 'error:42501',
  '12 a network group cannot be turned into a community group outside the RPCs');
SELECT is(t05579.ec(t05579.val('service_role', NULL, format('INSERT INTO public.chat_group_members (group_id, user_id, tenant_id) VALUES (%L, %L, %L) RETURNING user_id::text', t05579.g(1), t05579.u(2), '05579000-0000-4000-8000-0000000000a1'))), 'error:42501',
  '13 a direct service-role INSERT of a member into a network group fails');
SELECT is(t05579.val('service_role', NULL, format('INSERT INTO public.chat_group_members (group_id, user_id, tenant_id) VALUES (%L, %L, %L) RETURNING scope', t05579.g(4), t05579.u(15), '05579000-0000-4000-8000-0000000000a1')), 'community',
  '14 the community writers still add members to a community group directly, scope community');
SELECT is(t05579.val('service_role', NULL, format('INSERT INTO public.chat_group_members (group_id, user_id, tenant_id, scope) VALUES (%L, %L, %L, ''network'') RETURNING scope', t05579.g(4), t05579.u(12), '05579000-0000-4000-8000-0000000000a1')), 'community',
  '15 a member row can never carry another scope than its group (an explicit network is overridden)');
SELECT is(t05579.val('service_role', NULL, format('UPDATE public.chat_group_members SET last_read_at = now() WHERE group_id = %L AND user_id = %L RETURNING ''ok''', t05579.g(1), t05579.u(1))), 'ok',
  '16 read markers of a network group member can still be updated');
SELECT is(t05579.val('service_role', NULL, format('UPDATE public.chat_group_members SET scope = ''network'' WHERE group_id = %L AND user_id = %L RETURNING scope', t05579.g(4), t05579.u(15))), 'community',
  '17 an UPDATE of a member scope cannot leave the group scope');
SELECT is(t05579.ec(t05579.val('postgres', NULL, format('SELECT t05579.flag(%L)', format('INSERT INTO public.chat_groups (tenant_id, name, scope, is_system) VALUES (%L, ''sys'', ''network'', true) RETURNING id::text', '05579000-0000-4000-8000-0000000000a1')))), 'error:23514',
  '18 a network group can never be a system group (no system fan-out target)');
SELECT is(t05579.ec(t05579.val('postgres', NULL, format('SELECT t05579.flag(%L)', format('INSERT INTO public.chat_group_members (group_id, user_id, tenant_id, role) VALUES (%L, %L, %L, ''bot'') RETURNING user_id::text', t05579.g(1), t05579.u(2), '05579000-0000-4000-8000-0000000000a1')))), 'error:23514',
  '19 a bot can never be a member of a network group');
SELECT ok(t05579.val('postgres', NULL, format('INSERT INTO public.chat_group_members (group_id, user_id, tenant_id) VALUES (%L, %L, %L) ON CONFLICT DO NOTHING RETURNING user_id::text', t05579.g(1), t05579.u(1), '05579000-0000-4000-8000-0000000000a1')) IS NULL,
  '20 a re-run of the idempotent legacy migration over an existing network member is a no-op, not an error');

-- ── Task 2: create_network_group ─────────────────────────────────────────
INSERT INTO r VALUES ('g1', t05579.mk(1, 'U1 network group'));
SELECT ok((SELECT v FROM r WHERE k = 'g1') !~ '^error', '21 a network-visible member creates a network group');
SELECT ok(t05579.chk($q$SELECT EXISTS (SELECT 1 FROM public.chat_groups WHERE id::text = (SELECT v FROM r WHERE k = 'g1') AND scope = 'network'
  AND tenant_id = '05579000-0000-4000-8000-0000000000a1' AND created_by = t05579.u(1) AND NOT is_system)$q$),
  '22 scope network, tenant = the creator''s primary non-platform tenant (context only), created_by = the creator, not a system group');
SELECT ok(t05579.chk($q$SELECT EXISTS (SELECT 1 FROM public.chat_group_members WHERE group_id::text = (SELECT v FROM r WHERE k = 'g1') AND user_id = t05579.u(1)
  AND role = 'admin' AND scope = 'network' AND tenant_id = '05579000-0000-4000-8000-0000000000a1')$q$),
  '23 the creator is the first member and the admin of it');
INSERT INTO r VALUES ('g3', t05579.mk(3, 'U3 network group'));
SELECT ok(t05579.chk($q$SELECT EXISTS (SELECT 1 FROM public.chat_groups WHERE id::text = (SELECT v FROM r WHERE k = 'g3') AND scope = 'network' AND tenant_id = '05579000-0000-4000-8000-0000000000a2')$q$),
  '24 the context tenant is the creator''s own (TB), never the platform tenant it also belongs to');
SELECT is(t05579.mk(10), 'error:42501:no_context_tenant', '25 a member with only the platform tenant cannot create one');
SELECT is(t05579.mk(9), 'error:42501:actor_not_network_visible', '26 a member who is not network_visible cannot create one');
SELECT is(t05579.mk(5), 'error:42501:account_not_eligible', '27 a service bot cannot create one (rule 43-45)');
SELECT is(t05579.mk(6), 'error:42501:account_not_eligible', '28 a notification test actor cannot create one (rule 43-45)');
SELECT is(t05579.mk(7), 'error:42501:account_not_eligible', '29 a platform-only account cannot create one (rule 43-45)');
SELECT is(t05579.val('authenticated', NULL, 'SELECT public.create_network_group(''x'')::text'), 'error:28000:not_authenticated', '30 without a session it fails');
SELECT is(t05579.mk(1, '   '), 'error:22023:invalid_name', '31 a blank name is refused');
SELECT is(t05579.mk(1, repeat('x', 101)), 'error:22023:invalid_name', '32 a name over 100 characters is refused');

-- ── Task 2: grants and definer properties ────────────────────────────────
SELECT ok(t05579.chk($q$SELECT NOT has_function_privilege('anon', 'public.create_network_group(text,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.add_group_member(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.create_network_group_as(uuid,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.add_group_member_as(uuid,uuid,uuid)', 'EXECUTE')$q$), '33 anon can execute none of the four');
SELECT ok(t05579.chk($q$SELECT has_function_privilege('authenticated', 'public.create_network_group(text,text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.add_group_member(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.create_network_group_as(uuid,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.add_group_member_as(uuid,uuid,uuid)', 'EXECUTE')$q$), '34 authenticated gets the two caller-bound functions and not the _as pair');
SELECT ok(t05579.chk($q$SELECT has_function_privilege('service_role', 'public.create_network_group_as(uuid,text,text)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.add_group_member_as(uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.chat_group_add_member_core(uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.chat_group_add_member_core(uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.chat_group_create_core(uuid,text,text)', 'EXECUTE')$q$), '35 the _as pair is service_role-only and the two cores are executable by nobody');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('create_network_group', 'create_network_group_as', 'add_group_member', 'add_group_member_as',
    'chat_group_add_member_core', 'chat_group_create_core') AND p.prosecdef AND p.proconfig::text LIKE '%search_path=public, pg_temp%'), 6,
  '36 all six functions are SECURITY DEFINER with a pinned search_path');

-- ── Task 2: add_group_member, Network branch ─────────────────────────────
SELECT is(t05579.add(1, t05579.gid('g1'), 2), 'true', '37 the admin adds a connected member (accepted request, same tenant)');
SELECT ok(t05579.chk($q$SELECT EXISTS (SELECT 1 FROM public.chat_group_members WHERE group_id::text = (SELECT v FROM r WHERE k = 'g1') AND user_id = t05579.u(2)
  AND scope = 'network' AND role = 'member')$q$),
  '38 the new member row has scope network and role member');
SELECT is(t05579.add(1, t05579.gid('g1'), 3), 'true', '39 a member of ANOTHER tenant (TB) connected the other way round (U3 -> U1) is added');
SELECT is((SELECT tenant_id::text FROM public.chat_group_members WHERE group_id::text = (SELECT v FROM r WHERE k = 'g1') AND user_id = t05579.u(3)),
  '05579000-0000-4000-8000-0000000000a1', '40 the member row carries the creator''s tenant as context, not the member''s own');
SELECT is(t05579.add(1, t05579.gid('g1'), 8), 'error:42501:not_connected', '41 a pending request is not a connection');
SELECT is(t05579.add(1, t05579.gid('g1'), 12), 'error:42501:not_connected', '42 a member with no connection at all is refused');
SELECT is(t05579.add(1, t05579.gid('g1'), 11), 'error:42501:not_connected', '43 a declined request is not a connection');
SELECT is(t05579.add(4, t05579.gid('g1'), 15), 'error:42501:not_a_member', '44 a caller who is not a member of the group is refused');
SELECT is(t05579.add(2, t05579.gid('g1'), 15), 'error:42501:not_group_admin', '45 a plain member cannot invite (invite-only, admin only), even a connection of their own');
SELECT is(t05579.add(1, t05579.gid('g1'), 9), 'error:42501:target_not_network_visible', '46 a connection who is not network_visible is refused');
SELECT is(t05579.add(1, t05579.gid('g1'), 5), 'error:42501:account_not_eligible', '47 a service bot is never a member, even connected and visible (rule 43-45)');
SELECT is(t05579.add(1, t05579.gid('g1'), 6), 'error:42501:account_not_eligible', '48 a notification test actor is never a member (rule 43-45)');
SELECT is(t05579.add(1, t05579.gid('g1'), 7), 'error:42501:account_not_eligible', '49 a platform-only account is never a member (rule 43-45)');
SELECT is(t05579.add(1, t05579.gid('g1'), 13), 'error:42501:blocked', '50 a block by the inviter stops the invite');
SELECT is(t05579.add(1, t05579.gid('g1'), 14), 'error:42501:blocked', '51 a block by the invitee stops the invite');
SELECT is(t05579.add(1, t05579.gid('g1'), 1), 'error:22023:invalid_member', '52 adding yourself is refused (no self-join)');
SELECT is(t05579.val('authenticated', t05579.u(1), 'SELECT public.add_group_member(NULL::uuid, NULL::uuid)::text'), 'error:22023:invalid_argument', '53 a NULL argument is refused');
SELECT is(t05579.val('authenticated', NULL, format('SELECT public.add_group_member(%L::uuid, %L::uuid)::text', (SELECT v FROM r WHERE k = 'g1'), t05579.u(20))), 'error:28000:not_authenticated', '54 without a session it fails');
SELECT is(t05579.add(1, '05579000-0000-4000-8000-0000000000ff', 20), 'error:P0002:group_not_found', '55 an unknown group is refused');
SELECT is(t05579.add(1, t05579.gid('g1'), 2), 'false', '56 adding an existing member is a no-op (false)');
SELECT is((SELECT count(*)::int FROM public.chat_group_members WHERE group_id::text = (SELECT v FROM r WHERE k = 'g1')), 3, '57 the member count is unchanged by the refusals and the no-op (U1, U2, U3)');
SELECT is((SELECT count(*)::int FROM public.chat_messages WHERE group_id::text = (SELECT v FROM r WHERE k = 'g1')), 0,
  '58 no system fan-out: creating the group and adding members wrote no message');

-- The 20 member cap.
SELECT is(t05579.fill(1, t05579.gid('g1'), 20, 36), 17, '59 17 more connections are added (the group reaches 20)');
SELECT is((SELECT count(*)::int FROM public.chat_group_members WHERE group_id::text = (SELECT v FROM r WHERE k = 'g1')), 20, '60 the group has 20 members');
SELECT is(t05579.add(1, t05579.gid('g1'), 37), 'error:54000:group_full', '61 the 21st member is refused');
SELECT is((SELECT count(*)::int FROM public.chat_group_members WHERE group_id::text = (SELECT v FROM r WHERE k = 'g1')), 20, '62 the refusal added nobody');
SELECT is(t05579.add(1, t05579.gid('g1'), 20), 'false', '63 adding an existing member to a full group is a no-op, not group_full');
SELECT is(t05579.ec(t05579.val('service_role', NULL, format('SELECT t05579.flag(%L)', format('INSERT INTO public.chat_group_members (group_id, user_id, tenant_id) VALUES (%L, %L, %L) RETURNING user_id::text',
  (SELECT v FROM r WHERE k = 'g1'), t05579.u(38), '05579000-0000-4000-8000-0000000000a1')))), 'error:54000',
  '64 the cap also holds against a direct insert that sets the RPC flag (the table guard, not only the function)');
SELECT is(t05579.ec(t05579.val('postgres', NULL, format('SELECT t05579.flag(%L)', format('INSERT INTO public.chat_group_members (group_id, user_id, tenant_id) VALUES (%L, %L, %L) RETURNING user_id::text',
  t05579.g(1), t05579.u(6), '05579000-0000-4000-8000-0000000000a1')))), 'error:42501',
  '65 a rule 43-45 account cannot be inserted into a network group even with the RPC flag on');

-- add_group_member_as / create_network_group_as (the gateway, trusted p_actor).
SELECT is(t05579.adda(t05579.u(3), t05579.gid('g3'), 1), 'true', '66 add_group_member_as adds on behalf of the group admin (U3 -> U1 is a connection)');
SELECT is(t05579.adda(t05579.u(3), t05579.gid('g3'), 12), 'error:42501:not_connected', '67 add_group_member_as enforces the same connection rule');
SELECT is(t05579.adda(t05579.u(4), t05579.gid('g3'), 2), 'error:42501:not_a_member', '68 add_group_member_as enforces the same membership rule');
SELECT is(t05579.ec(t05579.val('authenticated', t05579.u(1), format('SELECT public.add_group_member_as(%L::uuid, %L::uuid, %L::uuid)::text', t05579.u(1), (SELECT v FROM r WHERE k = 'g1'), t05579.u(2)))), 'error:42501',
  '69 a client cannot call add_group_member_as');
INSERT INTO r VALUES ('g2', t05579.val('service_role', NULL, format('SELECT public.create_network_group_as(%L::uuid, ''via gateway'')::text', t05579.u(2))));
SELECT ok(t05579.chk($q$SELECT EXISTS (SELECT 1 FROM public.chat_groups WHERE id::text = (SELECT v FROM r WHERE k = 'g2') AND scope = 'network'
  AND tenant_id = '05579000-0000-4000-8000-0000000000a1' AND created_by = t05579.u(2))$q$),
  '70 create_network_group_as creates it for the named member, their tenant as context');

-- A migrated legacy network group (b1) can be extended through the same function.
SELECT is(t05579.add(1, t05579.g(1), 2), 'true', '71 the admin of a migrated legacy network group adds a connection');
SELECT is(t05579.add(3, t05579.g(1), 4), 'error:42501:not_group_admin', '72 a plain member of the legacy group cannot invite');

-- ── Task 2: add_group_member refuses every non-network group (review fix: no client write path into community groups) ──
SELECT is(t05579.add(1, t05579.g(4), 60), 'error:42501:not_network_group', '73 a community group member cannot add a member of the tenant through add_group_member');
SELECT is(t05579.val('postgres', NULL, format('SELECT count(*)::text FROM public.chat_group_members WHERE group_id = %L AND user_id = t05579.u(60)', t05579.g(4))), '0',
  '74 ... and no member row was written');
SELECT is(t05579.add(1, t05579.g(3), 60), 'error:42501:not_network_group', '75 the system group (is_system) refuses add_group_member too');
SELECT is(t05579.add(4, t05579.g(4), 61), 'error:42501:not_network_group', '76 a non-member gets the same refusal for a community group');
SELECT is(t05579.add(1, t05579.g(5), 12), 'error:42501:not_network_group', '77 the big community group takes no one through add_group_member either');

-- ── Task 1: participant-only RLS ─────────────────────────────────────────
SELECT is(t05579.val('authenticated', t05579.u(4), format('SELECT count(*)::text FROM public.chat_groups WHERE id = %L', (SELECT v FROM r WHERE k = 'g1'))), '0',
  '78 a non-participant (U4) sees no row of a network group');
SELECT is(t05579.val('authenticated', t05579.u(1), format('SELECT count(*)::text FROM public.chat_groups WHERE id = %L', (SELECT v FROM r WHERE k = 'g1'))), '1',
  '79 a participant sees it');
SELECT is(t05579.val('authenticated', t05579.u(4), format('SELECT count(*)::text FROM public.chat_group_members WHERE group_id = %L', (SELECT v FROM r WHERE k = 'g1'))), '0',
  '80 a non-participant sees none of its members');
SELECT is(t05579.val('authenticated', t05579.u(1), format('SELECT count(*)::text FROM public.chat_group_members WHERE group_id = %L', (SELECT v FROM r WHERE k = 'g1'))), '20',
  '81 a participant sees all 20');
SELECT is(t05579.val('authenticated', t05579.u(4), format('SELECT count(*)::text FROM public.chat_groups WHERE id = %L', t05579.g(1))), '0',
  '82 a migrated legacy network group is participant-only too');
SELECT is(t05579.val('anon', NULL, format('SELECT count(*)::text FROM public.chat_groups WHERE id = %L', (SELECT v FROM r WHERE k = 'g1'))), '0',
  '83 anon sees no group');
SELECT is(t05579.val('service_role', NULL, format('SELECT count(*)::text FROM public.chat_groups WHERE id = %L', (SELECT v FROM r WHERE k = 'g1'))), '1',
  '84 service_role (the gateway) still reads every group');
SELECT is(t05579.ec(t05579.val('authenticated', t05579.u(1), format('INSERT INTO public.chat_group_members (group_id, user_id, tenant_id) VALUES (%L, %L, %L) RETURNING user_id::text', t05579.g(4), t05579.u(4), '05579000-0000-4000-8000-0000000000a1'))), 'error:42501',
  '85 a client cannot insert a member (no INSERT policy)');
SELECT is(t05579.val('authenticated', t05579.u(1), format('WITH u AS (UPDATE public.chat_groups SET name = ''hacked'' WHERE id = %L RETURNING 1) SELECT count(*)::text FROM u', (SELECT v FROM r WHERE k = 'g1'))), '0',
  '86 a client cannot update a group (no UPDATE policy)');
SELECT is(t05579.val('authenticated', t05579.u(1), format('WITH d AS (DELETE FROM public.chat_group_members WHERE group_id = %L RETURNING 1) SELECT count(*)::text FROM d', (SELECT v FROM r WHERE k = 'g1'))), '0',
  '87 a client cannot remove a member (no DELETE policy)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('chat_groups', 'chat_group_members', 'chat_messages')
  AND (qual = 'true' OR with_check = 'true' OR (cmd = 'ALL' AND roles && ARRAY['public', 'authenticated', 'anon']::name[]))), 0,
  '88 no permissive FOR ALL USING (true) policy for PUBLIC/authenticated on chat_groups, chat_group_members or chat_messages');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('chat_groups', 'chat_group_members')
  AND (policyname IN ('chat_groups_service_role', 'chat_group_members_service_role') OR cmd <> 'SELECT')), 0,
  '89 the two groups tables carry SELECT policies only (the dropped service_role catch-alls stay gone)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('chat_groups', 'chat_group_members')
  AND (coalesce(qual, '') ~ 'current_tenant_id' OR coalesce(with_check, '') ~ 'current_tenant_id')), 0, '90 no bare current_tenant_id() policy on the groups tables');
SELECT ok((SELECT bool_and(qual ~ 'SELECT auth\.uid\(\)') FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('chat_groups', 'chat_group_members'))
  AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('chat_groups', 'chat_group_members')) = 2,
  '91 both read policies evaluate auth.uid() once per statement via (SELECT auth.uid())');
SELECT ok((SELECT count(*) FROM pg_trigger WHERE tgrelid IN ('public.chat_groups'::regclass, 'public.chat_group_members'::regclass) AND NOT tgisinternal
  AND tgname IN ('trg_chat_groups_scope_guard', 'trg_chat_groups_scope_sync', 'trg_chat_group_members_scope_guard')) = 3,
  '92 the three scope triggers exist');

SELECT * FROM finish();
ROLLBACK;
