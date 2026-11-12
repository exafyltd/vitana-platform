-- VTID-05558 (live-room-edit-cohost / db-cohost-authz): a listed co-host is a host for every moderation step of the
-- room, an unlisted member and a listed member of another tenant are not, nobody but the creator can remove a host,
-- and a browser session cannot write community_live_streams.co_hosts. Throwaway local Postgres only; never run it
-- against a shared or production database.
-- Run: scripts/ci/sql-tests/run-live-room-cohost-test.sh
\set ON_ERROR_STOP on

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

-- The Supabase auth.uid() the functions call: the user id is the 'sub' claim of the current request.
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

-- Only the columns and constraints the 13 functions touch.
create table public.user_tenants (user_id uuid not null, tenant_id uuid not null, primary key (user_id, tenant_id));
create table public.app_users (user_id uuid primary key, tenant_id uuid, display_name text);
create table public.notification_test_actors (user_id uuid primary key);
create table public.service_bot_accounts (user_id uuid primary key);
create table public.live_rooms (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, host_user_id uuid not null,
  title text, room_name text, room_slug text, status text not null default 'idle',
  current_session_id uuid, host_present boolean not null default false, access_level text default 'public',
  metadata jsonb default '{}'::jsonb, updated_at timestamptz default now()
);
create table public.live_room_sessions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, room_id uuid, session_title text,
  status text, access_level text default 'public', starts_at timestamptz, ends_at timestamptz,
  auto_admit boolean default true, lobby_buffer_minutes int default 15, max_participants int default 100,
  lobby_open_at timestamptz, host_present boolean default false, updated_at timestamptz default now()
);
create table public.live_room_attendance (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, live_room_id uuid, session_id uuid,
  user_id uuid not null, role text default 'guest', lobby_status text, joined_at timestamptz,
  left_at timestamptz, disconnected_at timestamptz, is_banned boolean not null default false
);
create unique index on public.live_room_attendance (tenant_id, session_id, user_id) where session_id is not null;
create table public.live_room_access_grants (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, user_id uuid, room_id uuid, session_id uuid,
  access_type text, is_valid boolean default true, is_revoked boolean default false, expires_at timestamptz
);
create table public.community_live_streams (
  id uuid primary key, title text, co_hosts text[] default '{}', created_by uuid
);
-- Unchanged by this migration; live_room_get_state calls it. Verbatim from 20260210100000_vtid_01228_live_room_session_mgmt.sql.
CREATE OR REPLACE FUNCTION public.live_room_get_counts(p_session_id UUID)
RETURNS JSONB AS $$
BEGIN
  RETURN (
    SELECT jsonb_build_object(
      'lobby_waiting', COUNT(*) FILTER (WHERE a.lobby_status = 'waiting' AND a.left_at IS NULL),
      'in_room', COUNT(*) FILTER (WHERE a.lobby_status = 'admitted' AND a.left_at IS NULL AND a.is_banned = false),
      'max_participants', (SELECT max_participants FROM public.live_room_sessions WHERE id = p_session_id),
      'host_present', (SELECT host_present FROM public.live_room_sessions WHERE id = p_session_id)
    )
    FROM public.live_room_attendance a
    WHERE a.session_id = p_session_id
  );
END;
$$ LANGUAGE plpgsql STABLE;

grant all on all tables in schema public to authenticated, anon, service_role;

\ir ../../../supabase/migrations/20261105170000_live_room_cohost_authz.sql

-- People. T1 is the creator's tenant, T2 another one.
create temp table cast_ (name text primary key, id uuid not null, tenant uuid not null);
insert into cast_ values
  ('creator', gen_random_uuid(), '11111111-1111-1111-1111-111111111111'),
  ('cohost',  gen_random_uuid(), '11111111-1111-1111-1111-111111111111'),
  ('stranger',gen_random_uuid(), '11111111-1111-1111-1111-111111111111'),
  ('guest',   gen_random_uuid(), '11111111-1111-1111-1111-111111111111'),
  ('other',   gen_random_uuid(), '22222222-2222-2222-2222-222222222222'),
  ('bot',     gen_random_uuid(), '11111111-1111-1111-1111-111111111111'),
  ('tester',  gen_random_uuid(), '11111111-1111-1111-1111-111111111111');
insert into public.user_tenants select id, tenant from cast_;
insert into public.app_users select id, tenant, name from cast_;
insert into public.service_bot_accounts select id from cast_ where name = 'bot';
insert into public.notification_test_actors select id from cast_ where name = 'tester';
create or replace function pg_temp.who(p text) returns uuid language sql as $$ select id from cast_ where name = p $$;
create or replace function pg_temp.as_user(p text) returns void language sql as
  $$ select set_config('request.jwt.claim.sub', coalesce((select id::text from cast_ where name = p), ''), true) $$;

-- A fresh live room: creator is the host, the listing row lists the co-host AND a member of another tenant.
create or replace function pg_temp.fresh_room(p_status text default 'live') returns uuid language plpgsql as $$
declare r uuid := gen_random_uuid(); s uuid := gen_random_uuid(); t uuid := '11111111-1111-1111-1111-111111111111';
begin
  insert into public.live_room_sessions (id, tenant_id, room_id, session_title, status, starts_at, ends_at)
    values (s, t, r, 'S', p_status, now(), now() + interval '1 hour');
  insert into public.live_rooms (id, tenant_id, host_user_id, room_name, room_slug, status, current_session_id, host_present)
    values (r, t, pg_temp.who('creator'), 'R', 'r-' || left(r::text, 8), p_status, s, true);
  insert into public.community_live_streams (id, title, co_hosts, created_by)
    values (r, 'R', array[pg_temp.who('cohost')::text, pg_temp.who('other')::text], pg_temp.who('creator'));
  return r;
end $$;

-- 1. The helper ---------------------------------------------------------------------------------------------------
do $$
declare r uuid := pg_temp.fresh_room(); bare uuid := gen_random_uuid();
begin
  assert public.live_room_is_host(r, pg_temp.who('creator')), 'creator is host';
  assert public.live_room_is_host(r, pg_temp.who('cohost')), 'listed co-host of the same tenant is host';
  assert not public.live_room_is_host(r, pg_temp.who('stranger')), 'unlisted member is not host';
  assert not public.live_room_is_host(r, pg_temp.who('other')), 'listed member of ANOTHER tenant is not host';
  assert not public.live_room_is_host(r, null), 'NULL user is not host';
  assert not public.live_room_is_host(gen_random_uuid(), pg_temp.who('creator')), 'unknown room: nobody is host';
  -- a room without a listing row, and a listing with NULL co_hosts: only the creator
  insert into public.live_rooms (id, tenant_id, host_user_id, status) values (bare, '11111111-1111-1111-1111-111111111111', pg_temp.who('creator'), 'live');
  assert public.live_room_is_host(bare, pg_temp.who('creator')) and not public.live_room_is_host(bare, pg_temp.who('cohost')), 'no listing row: creator only';
  insert into public.community_live_streams (id, title, co_hosts) values (bare, 'x', null);
  assert not public.live_room_is_host(bare, pg_temp.who('cohost')), 'NULL co_hosts: creator only';
  -- a co-host who left the tenant stops being host
  delete from public.user_tenants where user_id = pg_temp.who('cohost');
  assert not public.live_room_is_host(r, pg_temp.who('cohost')), 'co-host who left the tenant is not host';
  insert into public.user_tenants values (pg_temp.who('cohost'), '11111111-1111-1111-1111-111111111111');
  assert public.live_room_is_host(r, pg_temp.who('cohost')), 'and is host again once back';
end $$;

-- 2. The validator ------------------------------------------------------------------------------------------------
do $$
declare got uuid[]; c uuid := pg_temp.who('creator');
begin
  got := public.live_room_filter_co_hosts(c, array[pg_temp.who('cohost'), c, pg_temp.who('other'), pg_temp.who('bot'),
          pg_temp.who('tester'), pg_temp.who('cohost'), pg_temp.who('stranger'), null, gen_random_uuid()]);
  assert got = array[pg_temp.who('cohost'), pg_temp.who('stranger')], format('filter keeps same-tenant members only, in order, once (got %s)', got);
  assert public.live_room_filter_co_hosts(c, null) = '{}', 'NULL input -> empty';
  assert public.live_room_filter_co_hosts(c, '{}') = '{}', 'empty input -> empty';
  assert public.live_room_filter_co_hosts(null, array[pg_temp.who('cohost')]) = '{}', 'NULL creator -> empty';
end $$;

-- 3. Who may call the two functions: the gateway (service_role) only --------------------------------------------------
do $$
declare ok boolean := false; c uuid := pg_temp.who('creator'); h uuid := pg_temp.who('cohost');
begin
  -- ids are read BEFORE switching role: the temp cast table is not readable by service_role
  set local role service_role;
  assert public.live_room_filter_co_hosts(c, array[h]) = array[h], 'service_role can validate';
  assert public.live_room_is_host(gen_random_uuid(), c) = false, 'service_role can ask the helper';
  reset role;
  begin
    set local role authenticated;
    perform public.live_room_is_host(gen_random_uuid(), c);
  exception when insufficient_privilege then ok := true; end;
  reset role;
  assert ok, 'authenticated cannot call live_room_is_host';
  ok := false;
  begin
    set local role anon;
    perform public.live_room_filter_co_hosts(c, '{}');
  exception when insufficient_privilege then ok := true; end;
  reset role;
  assert ok, 'anon cannot call live_room_filter_co_hosts';
end $$;

-- 4. The gates: creator and co-host pass, stranger / other tenant / no user are refused --------------------------------
do $$
declare r uuid; res jsonb; who text; expected_ok boolean;
begin
  -- live_room_transition_status
  foreach who in array array['creator','cohost','stranger','other'] loop
    r := pg_temp.fresh_room('lobby'); perform pg_temp.as_user(who);
    res := public.live_room_transition_status(r, 'live', 'lobby');
    expected_ok := who in ('creator','cohost');
    assert (res->>'ok')::boolean = expected_ok, format('transition_status as %s: %s', who, res);
    assert expected_ok or res->>'error' = 'NOT_HOST', format('transition_status as %s refused with NOT_HOST: %s', who, res);
  end loop;
  -- live_room_end_session (also: no user at all is refused now)
  foreach who in array array['creator','cohost','stranger','other','nobody'] loop
    r := pg_temp.fresh_room('live'); perform pg_temp.as_user(who);
    res := public.live_room_end_session(r);
    expected_ok := who in ('creator','cohost');
    assert (res->>'ok')::boolean = expected_ok, format('end_session as %s: %s', who, res);
    assert expected_ok or res->>'error' = 'NOT_HOST', format('end_session as %s refused with NOT_HOST: %s', who, res);
    if expected_ok then
      assert (select status from public.live_rooms where id = r) = 'idle' and (select current_session_id from public.live_rooms where id = r) is null, 'ended room is idle';
    end if;
  end loop;
  -- live_room_get_lobby
  foreach who in array array['creator','cohost','stranger','other'] loop
    r := pg_temp.fresh_room('live'); perform pg_temp.as_user(who);
    res := public.live_room_get_lobby(r);
    assert (res->>'ok')::boolean = (who in ('creator','cohost')), format('get_lobby as %s: %s', who, res);
  end loop;
  -- live_room_update_metadata (boolean result; metadata actually changes)
  foreach who in array array['creator','cohost','stranger','other'] loop
    r := pg_temp.fresh_room('live'); perform pg_temp.as_user(who);
    assert public.live_room_update_metadata(r, jsonb_build_object('by', who)) = (who in ('creator','cohost')), format('update_metadata as %s', who);
    assert ((select metadata->>'by' from public.live_rooms where id = r) is not null) = (who in ('creator','cohost')), format('update_metadata effect as %s', who);
  end loop;
end $$;

-- 5. Lobby: admit / reject / admit_all by a co-host, refused for a stranger --------------------------------------------
do $$
declare r uuid; s uuid; res jsonb; g uuid := pg_temp.who('guest');
begin
  r := pg_temp.fresh_room('live'); s := (select current_session_id from public.live_rooms where id = r);
  insert into public.live_room_attendance (tenant_id, live_room_id, session_id, user_id, role, lobby_status, joined_at)
    values ('11111111-1111-1111-1111-111111111111', r, s, g, 'guest', 'waiting', now());
  perform pg_temp.as_user('stranger');
  assert public.live_room_admit_user(r, g)->>'error' = 'NOT_HOST' and public.live_room_reject_user(r, g)->>'error' = 'NOT_HOST'
     and public.live_room_admit_all(r)->>'error' = 'NOT_HOST', 'stranger cannot admit, reject or admit all';
  assert (select lobby_status from public.live_room_attendance where user_id = g and session_id = s) = 'waiting', 'guest still waiting after the stranger''s attempts';
  perform pg_temp.as_user('cohost');
  assert (public.live_room_admit_user(r, g)->>'ok')::boolean, 'co-host admits';
  assert (select lobby_status from public.live_room_attendance where user_id = g and session_id = s) = 'admitted', 'guest admitted by the co-host';
  update public.live_room_attendance set lobby_status = 'waiting' where user_id = g and session_id = s;
  res := public.live_room_reject_user(r, g);
  assert (res->>'ok')::boolean, format('co-host rejects: %s', res);
  assert (select lobby_status from public.live_room_attendance where user_id = g and session_id = s) = 'rejected', 'rejected guest is marked rejected';
  update public.live_room_attendance set lobby_status = 'waiting' where user_id = g and session_id = s;
  res := public.live_room_admit_all(r);
  assert (res->>'ok')::boolean and (res->>'admitted_count')::int = 1, format('co-host admits all: %s', res);
end $$;

-- 6. Kick and ban: a co-host removes guests, nobody but the creator removes a host -----------------------------------
do $$
declare r uuid; s uuid; res jsonb; g uuid := pg_temp.who('guest'); c uuid := pg_temp.who('creator'); h uuid := pg_temp.who('cohost');
begin
  r := pg_temp.fresh_room('live'); s := (select current_session_id from public.live_rooms where id = r);
  insert into public.live_room_attendance (tenant_id, live_room_id, session_id, user_id, role, lobby_status, joined_at) values
    ('11111111-1111-1111-1111-111111111111', r, s, g, 'guest', 'admitted', now()),
    ('11111111-1111-1111-1111-111111111111', r, s, c, 'host', 'admitted', now()),
    ('11111111-1111-1111-1111-111111111111', r, s, h, 'host', 'admitted', now());
  perform pg_temp.as_user('stranger');
  assert public.live_room_kick_user(r, g)->>'error' = 'NOT_HOST' and public.live_room_ban_user(r, g)->>'error' = 'NOT_HOST', 'stranger cannot kick or ban';
  perform pg_temp.as_user('cohost');
  assert public.live_room_kick_user(r, c)->>'error' = 'TARGET_IS_HOST', 'co-host cannot kick the creator';
  assert public.live_room_ban_user(r, c)->>'error' = 'TARGET_IS_HOST', 'co-host cannot ban the creator';
  assert (select left_at is null and not is_banned from public.live_room_attendance where user_id = c and session_id = s), 'creator untouched';
  res := public.live_room_kick_user(r, g);
  assert (res->>'ok')::boolean, format('co-host kicks a guest: %s', res);
  assert (select left_at is not null from public.live_room_attendance where user_id = g and session_id = s), 'kicked guest has left';
  update public.live_room_attendance set left_at = null where user_id = g and session_id = s;
  res := public.live_room_ban_user(r, g);
  assert (res->>'ok')::boolean, format('co-host bans a guest: %s', res);
  assert (select is_banned from public.live_room_attendance where user_id = g and session_id = s), 'banned guest is banned';
  perform pg_temp.as_user('creator');
  res := public.live_room_kick_user(r, h);
  assert (res->>'ok')::boolean, format('the creator can still remove a co-host: %s', res);
  assert (select left_at is not null from public.live_room_attendance where user_id = h and session_id = s), 'removed co-host has left';
end $$;

-- 7. host_present is one flag per room ----------------------------------------------------------------------------------
do $$
declare r uuid; s uuid; res jsonb; c uuid := pg_temp.who('creator'); h uuid := pg_temp.who('cohost');
begin
  r := pg_temp.fresh_room('live'); s := (select current_session_id from public.live_rooms where id = r);
  insert into public.live_room_attendance (tenant_id, live_room_id, session_id, user_id, role, lobby_status, joined_at) values
    ('11111111-1111-1111-1111-111111111111', r, s, c, 'host', 'admitted', now()),
    ('11111111-1111-1111-1111-111111111111', r, s, h, 'host', 'admitted', now());
  perform pg_temp.as_user('stranger');
  assert public.live_room_set_host_present(r, true)->>'error' = 'NOT_HOST', 'stranger cannot signal presence';
  perform pg_temp.as_user('cohost');
  assert (public.live_room_set_host_present(r, false)->>'host_present')::boolean, 'co-host leaving does not clear the flag while the creator is in';
  assert (select host_present from public.live_rooms where id = r), 'room still host_present';
  update public.live_room_attendance set left_at = now() where user_id = c and session_id = s;
  assert not (public.live_room_set_host_present(r, false)->>'host_present')::boolean, 'last host leaving clears the flag';
  assert not (select host_present from public.live_rooms where id = r), 'room no longer host_present';
  res := public.live_room_set_host_present(r, true);
  assert (res->>'host_present')::boolean, format('a co-host arriving sets it again: %s', res);
  assert (select host_present from public.live_rooms where id = r), 'room is host_present again';
end $$;

-- 8. Joining: a co-host joins as host and skips the lobby, guests are unchanged ----------------------------------------
do $$
declare r uuid; s uuid; res jsonb;
begin
  r := pg_temp.fresh_room('live'); s := (select current_session_id from public.live_rooms where id = r);
  update public.live_rooms set host_present = false where id = r;
  perform pg_temp.as_user('cohost');
  res := public.live_room_join_session(r, s);
  assert (res->>'ok')::boolean and res->>'role' = 'host' and res->>'lobby_status' = 'admitted', format('co-host joins as host even before the creator is present: %s', res);
  perform pg_temp.as_user('guest');
  res := public.live_room_join_session(r, s);
  assert res->>'error' = 'HOST_NOT_PRESENT', format('guest still needs a host present: %s', res);
  update public.live_rooms set host_present = true where id = r;
  res := public.live_room_join_session(r, s);
  assert (res->>'ok')::boolean and res->>'role' = 'guest', format('guest joins as guest: %s', res);
  perform pg_temp.as_user('other');
  res := public.live_room_join_session(r, s);
  assert (res->>'ok')::boolean and res->>'role' = 'guest', format('listed member of another tenant joins as a guest, never host: %s', res);
end $$;

-- 9. State snapshot and access ------------------------------------------------------------------------------------------
do $$
declare r uuid; res jsonb; t uuid := '11111111-1111-1111-1111-111111111111';
begin
  r := pg_temp.fresh_room('live');
  assert public.live_room_get_state(r, pg_temp.who('cohost'))->'viewer'->>'role' = 'host', 'state: co-host viewer role is host';
  assert public.live_room_get_state(r, pg_temp.who('creator'))->'viewer'->>'role' = 'host', 'state: creator viewer role is host';
  assert public.live_room_get_state(r, pg_temp.who('stranger'))->'viewer'->>'role' is null, 'state: stranger has no role';
  assert public.live_room_get_state(r, pg_temp.who('other'))->'viewer'->>'role' is null, 'state: other-tenant member has no role';
  assert public.live_room_check_access(pg_temp.who('cohost'), r, t), 'access: co-host needs no grant';
  assert public.live_room_check_access(pg_temp.who('creator'), r, t), 'access: creator needs no grant';
  assert not public.live_room_check_access(pg_temp.who('stranger'), r, t), 'access: stranger without a grant is refused';
  insert into public.live_room_access_grants (tenant_id, user_id, room_id, access_type) values (t, pg_temp.who('stranger'), r, 'paid');
  assert public.live_room_check_access(pg_temp.who('stranger'), r, t), 'access: a valid grant still works (unchanged)';
end $$;

-- 10. Only the gateway writes co_hosts ----------------------------------------------------------------------------------
do $$
declare ok boolean; id1 uuid := gen_random_uuid(); id2 uuid := gen_random_uuid();
        c uuid := pg_temp.who('creator'); h text := pg_temp.who('cohost')::text;
begin
  -- a browser session may write the other columns and an empty list
  set local role authenticated;
  insert into public.community_live_streams (id, title, created_by) values (id1, 'mine', c);
  update public.community_live_streams set title = 'renamed' where id = id1;
  update public.community_live_streams set co_hosts = co_hosts where id = id1;
  reset role;
  -- but not set co_hosts, on insert or update, as authenticated or anon
  ok := false; begin set local role authenticated; insert into public.community_live_streams (id, title, co_hosts) values (id2, 'x', array[h]);
  exception when insufficient_privilege then ok := true; end; reset role;
  assert ok, 'authenticated cannot insert a row with co_hosts';
  ok := false; begin set local role authenticated; update public.community_live_streams set co_hosts = array[h] where id = id1;
  exception when insufficient_privilege then ok := true; end; reset role;
  assert ok, 'authenticated cannot change co_hosts';
  ok := false; begin set local role anon; insert into public.community_live_streams (id, title, co_hosts) values (id2, 'x', array['a']);
  exception when insufficient_privilege then ok := true; end; reset role;
  assert ok, 'anon cannot insert a row with co_hosts';
  assert (select co_hosts from public.community_live_streams where id = id1) = '{}', 'nothing was stored';
  -- the gateway (service_role) and the migration owner can
  set local role service_role;
  update public.community_live_streams set co_hosts = array[h] where id = id1;
  reset role;
  assert (select co_hosts from public.community_live_streams where id = id1) = array[h], 'service_role writes co_hosts';
  update public.community_live_streams set co_hosts = '{}' where id = id1;
  assert (select co_hosts from public.community_live_streams where id = id1) = '{}', 'owner writes co_hosts';
end $$;

-- 11. Idempotent: applying the migration a second time changes nothing --------------------------------------------------
\ir ../../../supabase/migrations/20261105170000_live_room_cohost_authz.sql
do $$
begin
  assert public.live_room_is_host((select id from public.live_rooms limit 1), pg_temp.who('creator')) is not null, 'migration re-applies cleanly';
  assert (select count(*) from pg_trigger where tgname = 'trg_live_stream_co_hosts_gateway_only') = 1, 'one trigger after re-apply';
end $$;

\echo 'PASS vtid-05558 live room cohost'
