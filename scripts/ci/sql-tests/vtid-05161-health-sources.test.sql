-- VTID-05161: health_sources (Aurora only) — table, backfill from the health
-- rows of user_connections and from user_integrations, idempotency, the
-- connector_id FK, RLS own-read / no browser writes, the reconcile counts,
-- erase_user_data() discovery, and the user_integrations browser-write revoke.
-- Runs on a throwaway local Postgres shaped like Aurora (roles + auth.uid()
-- shim + an auth.users stub that the legacy user_integrations FK needs; NO
-- storage.objects). Never run against a shared or production database.
-- Run: scripts/ci/sql-tests/run-health-sources-test.sh
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
alter role service_role bypassrls;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$f$;
create table if not exists auth.users (id uuid primary key);
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase's default privileges (copied to Aurora by the privilege parity work).
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

-- Legacy models as the repository's migrations define them. The integrations
-- migration also seeds a Knowledge Hub doc; that function is stubbed (not under test).
create or replace function public.upsert_knowledge_doc(p_title text, p_path text, p_source_type text, p_tags text[], p_content text) returns uuid language sql as $f$ select null::uuid $f$;
\ir ../../../supabase/migrations/20260417000000_vtid_02100_connector_framework.sql
\ir ../../../supabase/migrations/20260417000100_vtid_02100_connector_registry_seed.sql
\ir ../../../supabase/migrations/20260417010000_vtid_02100_connector_registry_update.sql
\o /dev/null
\ir ../../../supabase/migrations/20260423200000_vitana_integrations_v1.sql
\o
-- user_tenants: the columns the backfill orders by (20251231000000_vtid_01101).
create table if not exists public.user_tenants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null,
  active_role text not null default 'community',
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);
\ir ../../../supabase/migrations/20261001120000_vtid_04765_erase_user_data.sql
\ir ../../../supabase/migrations/20261014100000_vtid_05158_erase_user_data_aurora_safe.sql

-- Fixtures. Members A..E, tenants T1/T2.
--   A: wearable fitbit active, oura disconnected, terra aggregator pending
--      (widget not completed), an instagram social row (must be excluded);
--      user_integrations manual-entry (connected) and oura (registered).
--   B: two fitbit rows with provider_user_id NULL (legacy unique treats NULLs
--      as distinct; health_sources' identity key does not) -> one skipped;
--      user_integrations whoop (no connector_registry row -> unmapped).
--   C: user_integrations manual-entry but no user_tenants row -> skipped.
--   D: two memberships; T2 is primary -> manual source lands in T2.
create temp table ids (k text primary key, v uuid);
insert into ids values
  ('T1', '10000000-0000-0000-0000-000000000001'), ('T2', '10000000-0000-0000-0000-000000000002'),
  ('A',  'a0000000-0000-0000-0000-00000000000a'), ('B',  'b0000000-0000-0000-0000-00000000000b'),
  ('C',  'c0000000-0000-0000-0000-00000000000c'), ('D',  'd0000000-0000-0000-0000-00000000000d');
insert into auth.users (id) select v from ids where k in ('A','B','C','D');
insert into public.user_tenants (tenant_id, user_id, is_primary, created_at) values
  ((select v from ids where k='T1'), (select v from ids where k='A'), true,  '2026-01-01'),
  ((select v from ids where k='T1'), (select v from ids where k='B'), true,  '2026-01-01'),
  ((select v from ids where k='T1'), (select v from ids where k='D'), false, '2026-01-01'),
  ((select v from ids where k='T2'), (select v from ids where k='D'), true,  '2026-02-01');

insert into public.user_connections (id, tenant_id, user_id, connector_id, category, provider_user_id,
                                     access_token, refresh_token, is_active, connected_at, disconnected_at, last_sync_at, sync_cursor, created_at)
values
  ('a1000000-0000-0000-0000-000000000001', (select v from ids where k='T1'), (select v from ids where k='A'), 'fitbit', 'wearable', 'fb-a',
   'sealed:v1:aaa', 'sealed:v1:bbb', true, '2026-03-01T10:00:00Z', null, '2026-10-12T06:00:00Z', '{"sleep_since":"2026-10-01"}', '2026-03-01'),
  ('a1000000-0000-0000-0000-000000000002', (select v from ids where k='T1'), (select v from ids where k='A'), 'oura', 'wearable', 'oura-a',
   null, null, false, '2026-04-01T10:00:00Z', '2026-05-01T10:00:00Z', null, '{}', '2026-04-01'),
  ('a1000000-0000-0000-0000-000000000003', (select v from ids where k='T1'), (select v from ids where k='A'), 'terra', 'aggregator', null,
   null, null, false, '2026-06-01T10:00:00Z', null, null, '{}', '2026-06-01'),
  ('a1000000-0000-0000-0000-000000000004', (select v from ids where k='T1'), (select v from ids where k='A'), 'instagram', 'social', 'ig-a',
   'sealed:v1:ccc', null, true, '2026-06-01T10:00:00Z', null, null, '{}', '2026-06-01'),
  ('b1000000-0000-0000-0000-000000000001', (select v from ids where k='T1'), (select v from ids where k='B'), 'fitbit', 'wearable', null,
   null, null, false, '2026-07-01T10:00:00Z', null, null, '{}', '2026-07-01'),
  ('b1000000-0000-0000-0000-000000000002', (select v from ids where k='T1'), (select v from ids where k='B'), 'fitbit', 'wearable', null,
   null, null, false, '2026-07-02T10:00:00Z', null, null, '{}', '2026-07-02');

insert into public.user_integrations (id, user_id, integration_id, status, connected_at, disconnected_at, last_sync_at, metadata, created_at) values
  ('a2000000-0000-0000-0000-000000000001', (select v from ids where k='A'), 'manual-entry', 'connected', '2026-05-01T08:00:00Z', null, '2026-10-12T07:00:00Z', '{"source":"manual_log"}', '2026-05-01'),
  ('a2000000-0000-0000-0000-000000000002', (select v from ids where k='A'), 'oura', 'disconnected', '2026-05-02T08:00:00Z', '2026-05-03T08:00:00Z', null, '{}', '2026-05-02'),
  ('b2000000-0000-0000-0000-000000000001', (select v from ids where k='B'), 'whoop', 'connected', '2026-05-04T08:00:00Z', null, null, '{}', '2026-05-04'),
  ('c2000000-0000-0000-0000-000000000001', (select v from ids where k='C'), 'manual-entry', 'connected', '2026-05-05T08:00:00Z', null, null, '{}', '2026-05-05'),
  ('d2000000-0000-0000-0000-000000000001', (select v from ids where k='D'), 'manual-entry', 'error', '2026-05-06T08:00:00Z', null, null, '{}', '2026-05-06');

-- Apply the B1 migration twice (idempotent).
\ir ../../../supabase/migrations/20261014100200_vtid_05161_health_sources.sql
\ir ../../../supabase/migrations/20261014100200_vtid_05161_health_sources.sql

-- ── 1. Backfill content and mapping.
do $$
declare v_n int; r record;
begin
  select count(*) into v_n from public.health_sources;
  -- A: 3 health connections + manual + oura(integration) = 5; B: 1 of the two NULL fitbit rows; D: manual = 1.
  if v_n <> 7 then raise exception 'FAIL: expected 7 backfilled sources, got %', v_n; end if;
  if exists (select 1 from public.health_sources where connector_id = 'instagram') then
    raise exception 'FAIL: a social connection was backfilled'; end if;

  select * into r from public.health_sources where legacy_user_connection_id = 'a1000000-0000-0000-0000-000000000001';
  if r.kind <> 'device_cloud' or r.status <> 'connected' or r.connector_id <> 'fitbit' or r.provider_user_id <> 'fb-a'
     or r.token_ref <> 'user_connections:a1000000-0000-0000-0000-000000000001'
     or r.sync_cursor <> '{"sleep_since":"2026-10-01"}'::jsonb or r.last_sync_at <> '2026-10-12T06:00:00Z'
     or r.tenant_id <> (select v from ids where k='T1') then
    raise exception 'FAIL: active fitbit mapped wrongly: %', row_to_json(r); end if;
  select * into r from public.health_sources where legacy_user_connection_id = 'a1000000-0000-0000-0000-000000000002';
  if r.status <> 'disconnected' or r.disconnected_at <> '2026-05-01T10:00:00Z' then
    raise exception 'FAIL: disconnected oura mapped wrongly: %', row_to_json(r); end if;
  select * into r from public.health_sources where legacy_user_connection_id = 'a1000000-0000-0000-0000-000000000003';
  if r.kind <> 'aggregator' or r.status <> 'pending' then
    raise exception 'FAIL: pending terra widget mapped wrongly: %', row_to_json(r); end if;
  if (select count(*) from public.health_sources where user_id = (select v from ids where k='B') and connector_id = 'fitbit') <> 1 then
    raise exception 'FAIL: duplicate NULL-provider fitbit rows not collapsed to one source'; end if;
  if (select legacy_user_connection_id from public.health_sources where user_id = (select v from ids where k='B'))
     <> 'b1000000-0000-0000-0000-000000000001' then
    raise exception 'FAIL: the older legacy row must win the identity key'; end if;

  select * into r from public.health_sources where legacy_user_integration_id = 'a2000000-0000-0000-0000-000000000001';
  if r.kind <> 'manual' or r.connector_id is not null or r.status <> 'connected' or r.token_ref is not null
     or r.last_sync_at <> '2026-10-12T07:00:00Z' then
    raise exception 'FAIL: manual-entry mapped wrongly: %', row_to_json(r); end if;
  select * into r from public.health_sources where legacy_user_integration_id = 'a2000000-0000-0000-0000-000000000002';
  if r.kind <> 'device_cloud' or r.connector_id <> 'oura' or r.status <> 'disconnected' then
    raise exception 'FAIL: registered integration id mapped wrongly: %', row_to_json(r); end if;
  if exists (select 1 from public.health_sources where legacy_user_integration_id in
             ('b2000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001')) then
    raise exception 'FAIL: an unmapped or tenant-less integration was backfilled'; end if;
  select * into r from public.health_sources where legacy_user_integration_id = 'd2000000-0000-0000-0000-000000000001';
  if r.tenant_id <> (select v from ids where k='T2') or r.status <> 'error' then
    raise exception 'FAIL: integration tenant must be the primary membership (T2) and status copied: %', row_to_json(r); end if;
end $$;

-- ── 2. Shape: token_ref is a pointer, there is no token column, no FK to auth.users.
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='health_sources'
              and column_name ~ '(access|refresh)_token|secret|password') then
    raise exception 'FAIL: health_sources has a token column'; end if;
  if (select is_nullable from information_schema.columns where table_schema='public' and table_name='health_sources' and column_name='connector_id') <> 'YES' then
    raise exception 'FAIL: connector_id must be nullable'; end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.health_sources'::regclass and contype = 'f'
              and confrelid = 'auth.users'::regclass) then
    raise exception 'FAIL: health_sources has an FK to auth.users'; end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.health_sources'::regclass and contype = 'f'
                  and confrelid = 'public.connector_registry'::regclass) then
    raise exception 'FAIL: connector_id has no FK to connector_registry'; end if;
  begin
    insert into public.health_sources (tenant_id, user_id, kind, connector_id, status, token_ref)
    values ((select v from ids where k='T1'), (select v from ids where k='A'), 'device_cloud', 'strava', 'connected', 'sealed:v1:abc');
    raise exception 'FAIL: a token-looking token_ref was accepted';
  exception when check_violation then null; end;
end $$;

-- ── 3. Kind / connector rules and the phone-store FK (C1 registers the ids).
do $$
declare v_t uuid := (select v from ids where k='T1'); v_u uuid := (select v from ids where k='A');
begin
  begin
    insert into public.health_sources (tenant_id, user_id, kind, connector_id, status) values (v_t, v_u, 'manual', 'fitbit', 'connected');
    raise exception 'FAIL: manual source with a connector accepted';
  exception when check_violation then null; end;
  begin
    insert into public.health_sources (tenant_id, user_id, kind, status) values (v_t, v_u, 'device_cloud', 'connected');
    raise exception 'FAIL: device_cloud source without a connector accepted';
  exception when check_violation then null; end;
  begin
    insert into public.health_sources (tenant_id, user_id, kind, connector_id, status) values (v_t, v_u, 'phone_store', 'apple_health', 'connected');
    raise exception 'FAIL: phone_store without an install id accepted';
  exception when check_violation then null; end;
  begin
    insert into public.health_sources (tenant_id, user_id, kind, connector_id, provider_user_id, status)
    values (v_t, v_u, 'phone_store', 'apple_health', 'install-1', 'connected');
    raise exception 'FAIL: phone_store accepted before apple_health is registered';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.health_sources (tenant_id, user_id, kind, status) values (v_t, v_u, 'wearable', 'connected');
    raise exception 'FAIL: unknown kind accepted';
  exception when check_violation then null; end;
  begin
    insert into public.health_sources (tenant_id, user_id, kind, status) values (v_t, v_u, 'voice', 'active');
    raise exception 'FAIL: unknown status accepted';
  exception when check_violation then null; end;
  -- After C1's registration row exists, the same insert works.
  insert into public.connector_registry (id, category, display_name, auth_type) values ('apple_health', 'wearable', 'Apple Health', 'sdk_bridge');
  insert into public.health_sources (tenant_id, user_id, kind, connector_id, provider_user_id, status)
  values (v_t, v_u, 'phone_store', 'apple_health', 'install-1', 'connected');
  -- Idempotent create key: a second identical source is refused by the identity key.
  begin
    insert into public.health_sources (tenant_id, user_id, kind, connector_id, provider_user_id, status)
    values (v_t, v_u, 'phone_store', 'apple_health', 'install-1', 'connected');
    raise exception 'FAIL: duplicate phone-store source accepted';
  exception when unique_violation then null; end;
  begin
    insert into public.health_sources (tenant_id, user_id, kind, status) values (v_t, v_u, 'manual', 'connected');
    raise exception 'FAIL: a second manual source for the same member accepted';
  exception when unique_violation then null; end;
  delete from public.health_sources where kind = 'phone_store';
  delete from public.connector_registry where id = 'apple_health';
end $$;

-- ── 4. updated_at trigger.
do $$
declare v_before timestamptz;
begin
  select updated_at into v_before from public.health_sources where legacy_user_connection_id = 'a1000000-0000-0000-0000-000000000003';
  perform pg_sleep(0.01);
  update public.health_sources set status = 'connected' where legacy_user_connection_id = 'a1000000-0000-0000-0000-000000000003';
  if (select updated_at from public.health_sources where legacy_user_connection_id = 'a1000000-0000-0000-0000-000000000003') <= v_before then
    raise exception 'FAIL: updated_at not bumped'; end if;
  update public.health_sources set status = 'pending' where legacy_user_connection_id = 'a1000000-0000-0000-0000-000000000003';
end $$;

-- ── 5. Reconcile counts.
do $$
declare j jsonb;
begin
  j := public.health_sources_reconcile_counts();
  -- After the backfill: B's second NULL fitbit row is unlinked (1), B's whoop is
  -- unmapped (1), C's manual-entry has no tenant (1). Nothing else.
  if (j->'mismatch'->>'connections_unlinked')::int <> 1 or (j->'mismatch'->>'integrations_unmapped')::int <> 1
     or (j->'mismatch'->>'integrations_no_tenant')::int <> 1 or (j->'mismatch'->>'integrations_unlinked')::int <> 0
     or (j->'mismatch'->>'status_mismatch')::int <> 0 or (j->'mismatch'->>'orphaned_sources')::int <> 0
     or (j->'mismatch'->>'total')::int <> 3 then
    raise exception 'FAIL: reconcile after backfill: %', j->'mismatch'; end if;
  if j::text ~ '[0-9a-f]{8}-[0-9a-f]{4}-' then raise exception 'FAIL: reconcile output carries an id'; end if;
  if not (j->'sources' @> '[{"kind":"manual","status":"connected","n":1}]'::jsonb) then
    raise exception 'FAIL: reconcile source counts: %', j->'sources'; end if;

  -- A legacy status change not mirrored -> status_mismatch; a deleted legacy row -> orphaned.
  update public.user_connections set is_active = false, disconnected_at = now() where id = 'a1000000-0000-0000-0000-000000000001';
  delete from public.user_integrations where id = 'd2000000-0000-0000-0000-000000000001';
  j := public.health_sources_reconcile_counts();
  if (j->'mismatch'->>'status_mismatch')::int <> 1 or (j->'mismatch'->>'orphaned_sources')::int <> 1 then
    raise exception 'FAIL: reconcile did not see the drift: %', j->'mismatch'; end if;
  update public.user_connections set is_active = true, disconnected_at = null where id = 'a1000000-0000-0000-0000-000000000001';
  insert into public.user_integrations (id, user_id, integration_id, status, connected_at, created_at)
  values ('d2000000-0000-0000-0000-000000000001', (select v from ids where k='D'), 'manual-entry', 'error', '2026-05-06T08:00:00Z', '2026-05-06');
end $$;

-- ── 6. Grants, RLS and function privileges.
do $$ begin
  if not (select relrowsecurity from pg_class where oid = 'public.health_sources'::regclass) then
    raise exception 'FAIL: RLS off on health_sources'; end if;
  if has_table_privilege('authenticated', 'public.health_sources', 'INSERT')
     or has_table_privilege('authenticated', 'public.health_sources', 'UPDATE')
     or has_table_privilege('authenticated', 'public.health_sources', 'DELETE')
     or has_table_privilege('anon', 'public.health_sources', 'SELECT') then
    raise exception 'FAIL: browser roles have more than member SELECT on health_sources'; end if;
  if has_function_privilege('authenticated', 'public.health_sources_reconcile_counts()', 'EXECUTE')
     or has_function_privilege('anon', 'public.health_sources_reconcile_counts()', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.health_sources_reconcile_counts()', 'EXECUTE') then
    raise exception 'FAIL: reconcile function is not service_role only'; end if;
  if not (select prosecdef from pg_proc where oid = 'public.health_sources_reconcile_counts()'::regprocedure)
     or (select provolatile from pg_proc where oid = 'public.health_sources_reconcile_counts()'::regprocedure) <> 's' then
    raise exception 'FAIL: reconcile function must be STABLE SECURITY DEFINER'; end if;
  if (select count(*) from pg_policies where schemaname='public' and tablename='health_sources') <> 1
     or exists (select 1 from pg_policies where schemaname='public' and tablename='health_sources' and cmd <> 'SELECT') then
    raise exception 'FAIL: health_sources must have exactly one SELECT policy'; end if;
end $$;

set role authenticated;
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-00000000000a';
do $$
declare v_n int;
begin
  select count(*) into v_n from public.health_sources;
  if v_n <> 5 then raise exception 'FAIL: member A sees % rows, expected their own 5', v_n; end if;
  begin
    insert into public.health_sources (tenant_id, user_id, kind, status)
    values ('10000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'voice', 'connected');
    raise exception 'FAIL: member inserted a source';
  exception when insufficient_privilege then null; end;
  begin
    update public.health_sources set status = 'paused';
    raise exception 'FAIL: member updated a source';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.health_sources;
    raise exception 'FAIL: member deleted a source';
  exception when insufficient_privilege then null; end;
  begin
    perform public.health_sources_reconcile_counts();
    raise exception 'FAIL: member ran the reconcile function';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set role anon;
do $$ begin
  begin
    perform count(*) from public.health_sources;
    raise exception 'FAIL: anon read health_sources';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ── 7. erase_user_data() finds health_sources by its catalogue scan.
do $$
declare j jsonb; v_left int;
begin
  if exists (select 1 from public.erasure_registry where table_name = 'health_sources') then
    raise exception 'FAIL: health_sources is in erasure_registry'; end if;
  j := public.erase_user_data('a0000000-0000-0000-0000-00000000000a', true);
  if not (j::text like '%health_sources%') then raise exception 'FAIL: dry run does not list health_sources: %', j; end if;
  perform public.erase_user_data('a0000000-0000-0000-0000-00000000000a', false);
  select count(*) into v_left from public.health_sources where user_id = 'a0000000-0000-0000-0000-00000000000a';
  if v_left <> 0 then raise exception 'FAIL: % health_sources rows left for the erased member', v_left; end if;
  if (select count(*) from public.health_sources) <> 2 then raise exception 'FAIL: erasure touched another member'; end if;
end $$;

-- ── 8. user_integrations browser-write revoke (Change 1c).
do $$ begin
  if not has_table_privilege('authenticated', 'public.user_integrations', 'INSERT') then
    raise exception 'FAIL: precondition — authenticated cannot write user_integrations before the revoke'; end if;
end $$;
set role authenticated;
set request.jwt.claim.sub = 'b0000000-0000-0000-0000-00000000000b';
insert into public.user_integrations (user_id, integration_id) values ('b0000000-0000-0000-0000-00000000000b', 'calm');
reset role;
\ir ../../../supabase/migrations/20261014100300_vtid_05161_user_integrations_revoke_browser_writes.sql
\ir ../../../supabase/migrations/20261014100300_vtid_05161_user_integrations_revoke_browser_writes.sql
set role authenticated;
set request.jwt.claim.sub = 'b0000000-0000-0000-0000-00000000000b';
do $$
declare v_n int;
begin
  select count(*) into v_n from public.user_integrations;
  if v_n <> 2 then raise exception 'FAIL: member B reads % own integration rows, expected 2', v_n; end if;
  begin
    insert into public.user_integrations (user_id, integration_id) values ('b0000000-0000-0000-0000-00000000000b', 'headspace');
    raise exception 'FAIL: member inserted into user_integrations after the revoke';
  exception when insufficient_privilege then null; end;
  begin
    update public.user_integrations set status = 'error';
    raise exception 'FAIL: member updated user_integrations after the revoke';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.user_integrations;
    raise exception 'FAIL: member deleted user_integrations after the revoke';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
-- The gateway (service_role) still writes.
set role service_role;
insert into public.user_integrations (user_id, integration_id) values ('b0000000-0000-0000-0000-00000000000b', 'headspace');
update public.user_integrations set status = 'disconnected' where integration_id = 'headspace';
delete from public.user_integrations where integration_id = 'headspace';
reset role;
do $$ begin
  if exists (select 1 from pg_policies where schemaname='public' and tablename='user_integrations' and policyname='user_integrations_owner_all') then
    raise exception 'FAIL: the FOR ALL policy survived'; end if;
end $$;

\echo 'PASS vtid-05161 health sources'
