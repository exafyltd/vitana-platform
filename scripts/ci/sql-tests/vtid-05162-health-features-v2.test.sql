-- VTID-05162: health_features_daily_v2, health_features_daily_legacy_shadow and
-- health_features_derivation_pending (Aurora only) — columns, unique keys,
-- checks, service-role-only access, idempotency, and erase_user_data()
-- discovery of all three plus B1's health_sources (no change to that
-- function). Runs on a throwaway local Postgres shaped like Aurora (roles +
-- auth.uid() shim + an auth.users stub the legacy user_integrations FK needs;
-- NO storage.objects). Never run against a shared or production database.
-- Run: scripts/ci/sql-tests/run-health-features-v2-test.sh
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
-- Supabase's default privileges (copied to Aurora by the privilege parity work):
-- the migration must REVOKE what these would otherwise grant.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

-- B1's health_sources (and what it needs) so erasure discovery covers B's four tables.
create or replace function public.upsert_knowledge_doc(p_title text, p_path text, p_source_type text, p_tags text[], p_content text) returns uuid language sql as $f$ select null::uuid $f$;
\ir ../../../supabase/migrations/20260417000000_vtid_02100_connector_framework.sql
\ir ../../../supabase/migrations/20260417000100_vtid_02100_connector_registry_seed.sql
\ir ../../../supabase/migrations/20260417010000_vtid_02100_connector_registry_update.sql
\o /dev/null
\ir ../../../supabase/migrations/20260423200000_vitana_integrations_v1.sql
\o
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
\ir ../../../supabase/migrations/20261014100200_vtid_05161_health_sources.sql

-- The B2 migration, twice (idempotent).
\ir ../../../supabase/migrations/20261014100700_vtid_05162_health_features_v2.sql
\ir ../../../supabase/migrations/20261014100700_vtid_05162_health_features_v2.sql

-- ── 1. Columns: the shadow has health_features_daily's columns (union of
--      VTID-01078, VTID-01103 and the 2026-04-23 repair); v2 adds two.
do $$
declare v_shadow text; v_v2 text; v_pending text;
begin
  select string_agg(column_name || ':' || data_type, ',' order by column_name) into v_shadow
    from information_schema.columns where table_schema = 'public' and table_name = 'health_features_daily_legacy_shadow';
  if v_shadow <> 'confidence:numeric,created_at:timestamp with time zone,date:date,feature_key:text,feature_unit:text,feature_value:numeric,id:uuid,metadata:jsonb,provenance:jsonb,sample_count:integer,tenant_id:uuid,updated_at:timestamp with time zone,user_id:uuid' then
    raise exception 'FAIL: legacy shadow columns: %', v_shadow; end if;
  select string_agg(column_name || ':' || data_type, ',' order by column_name) into v_v2
    from information_schema.columns where table_schema = 'public' and table_name = 'health_features_daily_v2';
  if v_v2 <> 'confidence:numeric,created_at:timestamp with time zone,date:date,derivation_version:text,feature_key:text,feature_unit:text,feature_value:numeric,id:uuid,metadata:jsonb,provenance:jsonb,sample_count:integer,source_kinds:ARRAY,tenant_id:uuid,updated_at:timestamp with time zone,user_id:uuid' then
    raise exception 'FAIL: v2 columns: %', v_v2; end if;
  select string_agg(column_name || ':' || data_type, ',' order by column_name) into v_pending
    from information_schema.columns where table_schema = 'public' and table_name = 'health_features_derivation_pending';
  if v_pending <> 'attempts:integer,date:date,enqueued_at:timestamp with time zone,tenant_id:uuid,user_id:uuid' then
    raise exception 'FAIL: pending columns: %', v_pending; end if;
end $$;

-- Fixtures: members A and B in tenant T1.
insert into auth.users (id) values ('a0000000-0000-0000-0000-00000000000a'), ('b0000000-0000-0000-0000-00000000000b');
insert into public.health_sources (tenant_id, user_id, kind, status) values
  ('10000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'diary', 'connected'),
  ('10000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 'diary', 'connected');
insert into public.health_features_daily_v2 (tenant_id, user_id, date, feature_key, feature_value, feature_unit, sample_count, confidence, metadata, derivation_version, source_kinds) values
  ('10000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', '2026-10-12', 'wearable_steps', 8000, 'steps', 1, 0.9, '{"source":"derived_v2"}', 'b2.1', '{device_cloud}'),
  ('10000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', '2026-10-12', 'water_intake', 1500, 'ml', 2, 0.85, '{"source":"derived_v2"}', 'b2.1', '{voice,diary}'),
  ('10000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', '2026-10-12', 'mood_entry', 4, 'score', 1, 0.85, '{"source":"derived_v2"}', 'b2.1', '{voice}');
insert into public.health_features_daily_legacy_shadow (tenant_id, user_id, date, feature_key, feature_value) values
  ('10000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', '2026-10-12', 'wearable_steps', 7900),
  ('10000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', '2026-10-12', 'mood_entry', 4);
insert into public.health_features_derivation_pending (tenant_id, user_id, date) values
  ('10000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', '2026-10-12'),
  ('10000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', '2026-10-13'),
  ('10000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', '2026-10-12');

-- ── 2. Unique keys and checks.
do $$ begin
  begin
    insert into public.health_features_daily_v2 (tenant_id, user_id, date, feature_key, feature_value, derivation_version)
      values ('10000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', '2026-10-12', 'wearable_steps', 1, 'b2.1');
    raise exception 'FAIL: duplicate (tenant,user,date,feature_key) accepted in v2';
  exception when unique_violation then null; end;
  begin
    insert into public.health_features_daily_legacy_shadow (tenant_id, user_id, date, feature_key, feature_value)
      values ('10000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', '2026-10-12', 'wearable_steps', 1);
    raise exception 'FAIL: duplicate key accepted in the legacy shadow';
  exception when unique_violation then null; end;
  begin
    insert into public.health_features_derivation_pending (tenant_id, user_id, date)
      values ('10000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', '2026-10-12');
    raise exception 'FAIL: duplicate pending marker accepted';
  exception when unique_violation then null; end;
  -- The gateway's marker upsert (ON CONFLICT on the unique key) refreshes, never duplicates.
  insert into public.health_features_derivation_pending (tenant_id, user_id, date, enqueued_at)
    values ('10000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', '2026-10-12', now())
    on conflict (tenant_id, user_id, date) do update set enqueued_at = excluded.enqueued_at;
  begin
    insert into public.health_features_daily_v2 (tenant_id, user_id, date, feature_key, feature_value)
      values ('10000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', '2026-10-11', 'wearable_steps', 1);
    raise exception 'FAIL: v2 row without derivation_version accepted';
  exception when not_null_violation then null; end;
  begin
    insert into public.health_features_daily_v2 (tenant_id, user_id, date, feature_key, feature_value, derivation_version, source_kinds)
      values ('10000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', '2026-10-11', 'wearable_steps', 1, 'b2.1', '{bogus}');
    raise exception 'FAIL: unknown source kind accepted';
  exception when check_violation then null; end;
  begin
    update public.health_features_derivation_pending set attempts = -1;
    raise exception 'FAIL: negative attempts accepted';
  exception when check_violation then null; end;
end $$;

-- ── 3. Service role only: RLS on, no policy, no browser privilege.
do $$
declare t text; p text; r text;
begin
  foreach t in array array['health_features_daily_v2', 'health_features_daily_legacy_shadow', 'health_features_derivation_pending'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'FAIL: RLS off on %', t; end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception 'FAIL: % has a policy (service role only)', t; end if;
    foreach r in array array['anon', 'authenticated'] loop
      foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(r, 'public.' || t, p) then
          raise exception 'FAIL: % has % on %', r, p, t; end if;
      end loop;
    end loop;
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not has_table_privilege('service_role', 'public.' || t, p) then
        raise exception 'FAIL: service_role lacks % on %', p, t; end if;
    end loop;
    if exists (select 1 from pg_constraint where conrelid = ('public.' || t)::regclass and contype = 'f') then
      raise exception 'FAIL: % has a foreign key (erasure discovery needs none to auth.users)', t; end if;
    if exists (select 1 from public.erasure_registry where table_name = t) then
      raise exception 'FAIL: % is in erasure_registry', t; end if;
  end loop;
end $$;
set role authenticated;
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-00000000000a';
do $$ begin
  begin
    perform 1 from public.health_features_daily_v2;
    raise exception 'FAIL: a member read health_features_daily_v2';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.health_features_derivation_pending (tenant_id, user_id, date)
      values ('10000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', '2026-10-01');
    raise exception 'FAIL: a member wrote a pending marker';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ── 4. erase_user_data() finds all four of B's tables by its catalogue scan.
do $$
declare j jsonb; t text; v_n int;
begin
  j := public.erase_user_data('a0000000-0000-0000-0000-00000000000a', true);
  if (j -> 'deleted' ->> 'health_features_daily_v2')::int <> 2 then raise exception 'FAIL: dry run v2 count: %', j; end if;
  if (j -> 'deleted' ->> 'health_features_daily_legacy_shadow')::int <> 1 then raise exception 'FAIL: dry run shadow count: %', j; end if;
  if (j -> 'deleted' ->> 'health_features_derivation_pending')::int <> 2 then raise exception 'FAIL: dry run pending count: %', j; end if;
  if (j -> 'deleted' ->> 'health_sources')::int <> 1 then raise exception 'FAIL: dry run health_sources count: %', j; end if;
  if (select count(*) from public.health_features_daily_v2) <> 3 then raise exception 'FAIL: the dry run deleted rows'; end if;

  perform public.erase_user_data('a0000000-0000-0000-0000-00000000000a', false);
  foreach t in array array['health_features_daily_v2', 'health_features_daily_legacy_shadow', 'health_features_derivation_pending', 'health_sources'] loop
    execute format('select count(*) from public.%I where user_id = $1', t) into v_n using 'a0000000-0000-0000-0000-00000000000a'::uuid;
    if v_n <> 0 then raise exception 'FAIL: % % rows left for the erased member', v_n, t; end if;
  end loop;
  if (select count(*) from public.health_features_daily_v2) <> 1
     or (select count(*) from public.health_features_daily_legacy_shadow) <> 1
     or (select count(*) from public.health_features_derivation_pending) <> 1
     or (select count(*) from public.health_sources) <> 1 then
    raise exception 'FAIL: erasure touched another member'; end if;
end $$;

\echo 'PASS vtid-05162 health features v2'
