-- VTID-05158: the health store (partitioned tiers, ingest, rollups, purge,
-- suppression, erasure, RLS) against a throwaway local Postgres that looks
-- like Aurora: roles + the auth.uid() shim, NO auth.users, NO storage.objects.
-- Never run against a shared or production database.
-- Run: scripts/ci/sql-tests/run-health-store-test.sh
\set ON_ERROR_STOP on
set client_min_messages = warning;

-- Aurora shapes the migration relies on (scripts/aurora/migrations/0001_auth_shim.sql).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
-- As on Aurora (scripts/aurora/migrations/0000_auth_roles.sql) and Supabase.
alter role service_role bypassrls;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$f$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase's default privileges (copied to Aurora by the privilege parity
-- work): every new public table is granted to the browser roles unless the
-- migration revokes it. Partitions must still be unreadable directly.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

\ir ../../../supabase/migrations/20261001120000_vtid_04765_erase_user_data.sql
\ir ../../../supabase/migrations/20261014100000_vtid_05158_erase_user_data_aurora_safe.sql
\ir ../../../supabase/migrations/20261014100100_vtid_05158_health_store.sql
-- Idempotent: a second apply changes nothing and does not fail.
\ir ../../../supabase/migrations/20261014100100_vtid_05158_health_store.sql

-- ── 1. Partitions exist, are attached, and have the parent's exact column types.
do $$
declare
  v_parent text; v_bad int; v_today date := (now() at time zone 'UTC')::date;
begin
  foreach v_parent in array array['health_series_5m','health_series_1h','health_series_1d','health_observations',
                                  'health_ingest_batches','health_ingest_quarantine'] loop
    if not exists (select 1 from pg_inherits where inhparent = ('public.' || v_parent)::regclass) then
      raise exception 'FAIL: % has no partitions', v_parent;
    end if;
    select count(*) into v_bad
      from pg_inherits i
      join pg_attribute pa on pa.attrelid = i.inhparent and pa.attnum > 0 and not pa.attisdropped
      left join pg_attribute ca on ca.attrelid = i.inhrelid and ca.attname = pa.attname and not ca.attisdropped
     where i.inhparent = ('public.' || v_parent)::regclass
       and (ca.attname is null or ca.atttypid <> pa.atttypid or ca.atttypmod <> pa.atttypmod);
    if v_bad > 0 then raise exception 'FAIL: % has % partition column(s) with a different type/typmod', v_parent, v_bad; end if;
    if exists (select 1 from pg_inherits i join pg_class c on c.oid = i.inhrelid
                where i.inhparent = ('public.' || v_parent)::regclass and pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT') then
      raise exception 'FAIL: % has a DEFAULT partition', v_parent;
    end if;
  end loop;
  if to_regclass('public.health_series_5m_p' || to_char(v_today, 'YYYYMMDD')) is null
     or to_regclass('public.health_series_5m_p' || to_char(v_today + 30, 'YYYYMMDD')) is null
     or to_regclass('public.health_series_5m_p' || to_char(v_today - 30, 'YYYYMMDD')) is null then
    raise exception 'FAIL: 5-minute partitions do not cover today-30 .. today+30';
  end if;
  if to_regclass('public.health_series_1h_p202507') is null
     or to_regclass('public.health_observations_p' || to_char(v_today + interval '3 months', 'YYYYMM')) is null
     or to_regclass('public.health_series_1d_p202603') is null then
    raise exception 'FAIL: monthly partitions do not cover 2025-07 .. now + 3 months';
  end if;
  if exists (select 1 from public.health_store_partition_check(now())) then
    raise exception 'FAIL: partition_check reports a missing partition right after ensure';
  end if;
  if not exists (select 1 from public.health_store_partition_check(now() + interval '60 days') where parent = 'health_series_5m') then
    raise exception 'FAIL: partition_check does not report a missing 5-minute partition 60 days ahead';
  end if;
  -- A second ensure creates nothing (no churn).
  if public.health_store_ensure_partitions(now()) <> 0 then raise exception 'FAIL: ensure is not idempotent'; end if;
end $$;

-- ── 2. Catalogue: seeded, no glucose code, the CHECK refuses one.
do $$ begin
  if (select count(*) from public.health_codes) < 10 then raise exception 'FAIL: catalogue not seeded'; end if;
  if exists (select 1 from public.health_codes where key ~* '(gluc|hba1c|cgm)') then raise exception 'FAIL: glucose code in catalogue'; end if;
  begin
    insert into public.health_codes (code_id, key, unit, kind, category) values (999, 'blood_glucose', 'mg/dL', 'record', 'labs');
    raise exception 'FAIL: glucose code accepted';
  exception when check_violation then null;
  end;
end $$;

-- Test identities.
create temp table t_ids as select
  '00000000-0000-0000-0000-0000000000a1'::uuid as tenant,
  '00000000-0000-0000-0000-00000000000a'::uuid as user_a,
  '00000000-0000-0000-0000-00000000000b'::uuid as user_b,
  '00000000-0000-0000-0000-0000000005a1'::uuid as src_watch,
  '00000000-0000-0000-0000-0000000005a2'::uuid as src_phone,
  '00000000-0000-0000-0000-0000000005b1'::uuid as src_b,
  '00000000-0000-0000-0000-00000000c0a1'::uuid as consent,
  (date_trunc('day', now() at time zone 'UTC') - interval '2 days' + interval '10 hours') at time zone 'UTC' as h10;
grant select on t_ids to service_role;

-- Helper: the store's content as one hash (ingested_at included, so a
-- duplicate write that touched a row would show).
create function pg_temp.store_hash() returns text language sql as $$
  select md5(coalesce((select string_agg(t::text, '|' order by t::text) from public.health_series_5m t), '')
          || coalesce((select string_agg(t::text, '|' order by t::text) from public.health_series_1h t), '')
          || coalesce((select string_agg(t::text, '|' order by t::text) from public.health_series_1d t), '')
          || coalesce((select string_agg(t::text, '|' order by t::text) from public.health_observations t), ''))
$$;

-- The ingest runs as the gateway (service_role).
set role service_role;

-- ── 3. Ingest, replace idempotency, rollups (sum and stats codes).
create temp table t_r (step text, res jsonb);
do $$
declare i record; r jsonb; v_series jsonb; v_records jsonb;
begin
  select * into i from t_ids;
  v_series := jsonb_build_array(
    jsonb_build_object('code_id', 1, 'bucket_start', i.h10, 'sum', 100),
    jsonb_build_object('code_id', 1, 'bucket_start', i.h10 + interval '5 minutes', 'sum', 200),
    jsonb_build_object('code_id', 1, 'bucket_start', i.h10 + interval '55 minutes', 'sum', 50),
    jsonb_build_object('code_id', 40, 'bucket_start', i.h10, 'n', 5, 'sum', 300, 'min', 55, 'max', 70),
    jsonb_build_object('code_id', 40, 'bucket_start', i.h10 + interval '5 minutes', 'n', 3, 'sum', 240, 'min', 75, 'max', 85),
    jsonb_build_object('code_id', 1, 'bucket_start', i.h10 + interval '7 minutes', 'sum', 1),      -- misaligned
    jsonb_build_object('code_id', 60, 'bucket_start', i.h10, 'sum', 1));                           -- record code as series
  v_records := jsonb_build_array(
    jsonb_build_object('source_record_id', 'w-1', 'code_id', 60, 'value', 80.5, 'unit', 'kg', 'effective_start', i.h10),
    jsonb_build_object('source_record_id', 's-1', 'code_id', 20, 'value', 420, 'unit', 'min',
                       'effective_start', i.h10 - interval '9 hours', 'effective_end', i.h10 - interval '2 hours',
                       'detail', jsonb_build_object('stages', jsonb_build_array(jsonb_build_object('stage', 'deep', 'min', 90)))));
  r := public.health_store_ingest(i.tenant, i.user_a, gen_random_uuid(), i.src_watch, 'device_cloud', 1::smallint, i.consent, 'UTC', v_series, v_records);
  insert into t_r values ('first', r);
  if (r->'counts'->>'stored')::int <> 7 then raise exception 'FAIL: first ingest stored: %', r; end if;
  if (r->'counts'->>'invalid')::int <> 2 then raise exception 'FAIL: misaligned/non-series items not invalid: %', r; end if;
  insert into t_r values ('hash1', to_jsonb(pg_temp.store_hash()));

  -- Same content again: every item duplicate, nothing changes.
  r := public.health_store_ingest(i.tenant, i.user_a, gen_random_uuid(), i.src_watch, 'device_cloud', 1::smallint, i.consent, 'UTC', v_series, v_records);
  if (r->'counts'->>'duplicate')::int <> 7 or r->'counts' ? 'stored' or r->'counts' ? 'updated' then
    raise exception 'FAIL: replay not duplicate: %', r;
  end if;
  if pg_temp.store_hash() <> (select t_r.res #>> '{}' from t_r where step = 'hash1') then
    raise exception 'FAIL: identical batch changed stored rows';
  end if;
end $$;

do $$
declare i record; v record;
begin
  select * into i from t_ids;
  if (select count(*) from public.health_series_5m where user_id = i.user_a) <> 5 then raise exception 'FAIL: 5m rows'; end if;
  select * into v from public.health_series_1h where user_id = i.user_a and code_id = 1 and bucket_start = i.h10;
  if v.sum is distinct from 350::float8 then raise exception 'FAIL: hourly steps sum = %', v.sum; end if;
  select * into v from public.health_series_1h where user_id = i.user_a and code_id = 40 and bucket_start = i.h10;
  if v.n <> 8 or v.sum <> 540 or v.min <> 55 or v.max <> 85 then raise exception 'FAIL: hourly HR stats %', row_to_json(v); end if;
  select * into v from public.health_series_1d where user_id = i.user_a and code_id = 1;
  if v.sum <> 350 or v.local_date <> (i.h10 at time zone 'UTC')::date or v.tz <> 'UTC' or v.consent_id <> i.consent then
    raise exception 'FAIL: daily steps %', row_to_json(v);
  end if;
  if (select count(*) from public.health_observations where user_id = i.user_a) <> 2 then raise exception 'FAIL: records'; end if;
  if (select consent_id from public.health_observations where source_record_id = 'w-1') <> i.consent then raise exception 'FAIL: consent id not stored'; end if;
end $$;

-- ── 4. Replace: changed content → updated, rollups follow; delete → deleted/not_found.
do $$
declare i record; r jsonb;
begin
  select * into i from t_ids;
  r := public.health_store_ingest(i.tenant, i.user_a, gen_random_uuid(), i.src_watch, 'device_cloud', 1::smallint, i.consent, 'UTC',
         jsonb_build_array(jsonb_build_object('code_id', 1, 'bucket_start', i.h10, 'sum', 400)),
         jsonb_build_array(jsonb_build_object('source_record_id', 'w-1', 'code_id', 60, 'value', 81, 'unit', 'kg', 'effective_start', i.h10)));
  if (r->'counts'->>'updated')::int <> 2 then raise exception 'FAIL: replace not updated: %', r; end if;
  if (select sum from public.health_series_1h where user_id = i.user_a and code_id = 1 and bucket_start = i.h10) <> 650 then
    raise exception 'FAIL: hourly not recomputed after replace';
  end if;
  if (select sum from public.health_series_1d where user_id = i.user_a and code_id = 1) <> 650 then raise exception 'FAIL: daily not recomputed'; end if;
  if (select value from public.health_observations where source_record_id = 'w-1') <> 81
     or (select count(*) from public.health_observations where source_record_id = 'w-1') <> 1 then
    raise exception 'FAIL: record not replaced';
  end if;

  r := public.health_store_ingest(i.tenant, i.user_a, gen_random_uuid(), i.src_watch, 'device_cloud', 1::smallint, i.consent, 'UTC',
         jsonb_build_array(jsonb_build_object('code_id', 1, 'bucket_start', i.h10 + interval '55 minutes', 'op', 'delete'),
                           jsonb_build_object('code_id', 1, 'bucket_start', i.h10 + interval '30 minutes', 'op', 'delete')),
         jsonb_build_array(jsonb_build_object('source_record_id', 'nope', 'op', 'delete')));
  if (r->'counts'->>'deleted')::int <> 1 or (r->'counts'->>'not_found')::int <> 2 then raise exception 'FAIL: deletions %', r; end if;
  if r->'deleted_dates' <> jsonb_build_array((i.h10 at time zone 'UTC')::date) then raise exception 'FAIL: deleted_dates %', r; end if;
  if (select sum from public.health_series_1h where user_id = i.user_a and code_id = 1 and bucket_start = i.h10) <> 600 then
    raise exception 'FAIL: hourly not recomputed after delete';
  end if;
end $$;

-- ── 5. Old series go straight to the hourly tier; daily tz attribution on a
--       Europe/Berlin DST day (2026-03-29 has 23 local hours).
do $$
declare i record; r jsonb;
begin
  select * into i from t_ids;
  r := public.health_store_ingest(i.tenant, i.user_a, gen_random_uuid(), i.src_phone, 'phone_store', 2::smallint, i.consent, 'Europe/Berlin',
         jsonb_build_array(
           jsonb_build_object('code_id', 1, 'bucket_start', '2026-03-28T22:00:00Z', 'sum', 1),    -- 23:00 CET, 28th
           jsonb_build_object('code_id', 1, 'bucket_start', '2026-03-28T23:00:00Z', 'sum', 10),   -- 00:00 CET, 29th
           jsonb_build_object('code_id', 1, 'bucket_start', '2026-03-29T21:00:00Z', 'sum', 100),  -- 23:00 CEST, 29th
           jsonb_build_object('code_id', 1, 'bucket_start', '2026-03-29T22:00:00Z', 'sum', 1000), -- 00:00 CEST, 30th
           jsonb_build_object('code_id', 1, 'bucket_start', '2026-03-29T22:05:00Z', 'sum', 1)),   -- old + not hour-aligned
         '[]'::jsonb);
  if (r->'counts'->>'stored')::int <> 4 or (r->'counts'->>'invalid')::int <> 1 then raise exception 'FAIL: old series %', r; end if;
  if exists (select 1 from public.health_series_5m where source_id = i.src_phone) then raise exception 'FAIL: old series in the 5m tier'; end if;
  if (select count(*) from public.health_series_1h where source_id = i.src_phone) <> 4 then raise exception 'FAIL: old series not hourly'; end if;
  if (select sum from public.health_series_1d where source_id = i.src_phone and local_date = '2026-03-28') <> 1
     or (select sum from public.health_series_1d where source_id = i.src_phone and local_date = '2026-03-29') <> 110
     or (select sum from public.health_series_1d where source_id = i.src_phone and local_date = '2026-03-30') <> 1000
     or (select tz from public.health_series_1d where source_id = i.src_phone and local_date = '2026-03-29') <> 'Europe/Berlin' then
    raise exception 'FAIL: DST daily attribution %', (select jsonb_agg(row_to_json(d)) from public.health_series_1d d where source_id = i.src_phone);
  end if;
end $$;

-- ── 6. Best-ranked source wins in the daily resolver.
do $$
declare i record; v record;
begin
  select * into i from t_ids;
  perform public.health_store_ingest(i.tenant, i.user_a, gen_random_uuid(), i.src_phone, 'phone_store', 2::smallint, i.consent, 'UTC',
            jsonb_build_array(jsonb_build_object('code_id', 1, 'bucket_start', i.h10, 'sum', 7)), '[]'::jsonb);
  if (select count(*) from public.health_series_1d where user_id = i.user_a and code_id = 1 and local_date = (i.h10 at time zone 'UTC')::date) <> 2 then
    raise exception 'FAIL: expected two sources for the day';
  end if;
  select * into v from public.health_series_daily_resolved(i.user_a, array[1]::smallint[], (i.h10 at time zone 'UTC')::date, (i.h10 at time zone 'UTC')::date);
  if v.source_id <> i.src_watch or v.sum <> 600 then raise exception 'FAIL: resolver picked %', row_to_json(v); end if;
end $$;

-- ── 7. A second member, for isolation, erasure and RLS.
do $$
declare i record;
begin
  select * into i from t_ids;
  perform public.health_store_ingest(i.tenant, i.user_b, gen_random_uuid(), i.src_b, 'device_cloud', 1::smallint, null, 'UTC',
            jsonb_build_array(jsonb_build_object('code_id', 1, 'bucket_start', i.h10, 'sum', 5)),
            jsonb_build_array(jsonb_build_object('source_record_id', 'b-w', 'code_id', 60, 'value', 70, 'unit', 'kg', 'effective_start', i.h10)));
  insert into public.health_ingest_batches (tenant_id, user_id, batch_id, body_sha256, source_id, via)
  values (i.tenant, i.user_a, gen_random_uuid(), 'x', i.src_watch, 'internal'),
         (i.tenant, i.user_b, gen_random_uuid(), 'y', i.src_b, 'internal');
  insert into public.health_ingest_quarantine (tenant_id, user_id, batch_id, item_index, code_key, reason)
  values (i.tenant, i.user_a, gen_random_uuid(), 0, 'steps', 'IMPLAUSIBLE'),
         (i.tenant, i.user_b, gen_random_uuid(), 0, 'steps', 'IMPLAUSIBLE');
end $$;

-- ── 8. Chunk limit and argument checks.
do $$
declare i record;
begin
  select * into i from t_ids;
  begin
    perform public.health_store_ingest(i.tenant, i.user_a, gen_random_uuid(), i.src_watch, 'device_cloud', 1::smallint, null, 'UTC',
              (select jsonb_agg(jsonb_build_object('code_id', 1, 'bucket_start', i.h10, 'sum', g)) from generate_series(1, 2001) g), '[]');
    raise exception 'FAIL: 2001 items accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.health_store_ingest(i.tenant, null, gen_random_uuid(), i.src_watch, 'device_cloud', 1::smallint, null, 'UTC', '[]', '[]');
    raise exception 'FAIL: null user accepted';
  exception when invalid_parameter_value then null;
  end;
end $$;

reset role;

-- ── 9. RLS: own, un-suppressed rows only; no writes; nothing for anon.
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
set role authenticated;
do $$
declare v_part text := 'health_series_5m_p' || to_char((now() at time zone 'UTC')::date - 2, 'YYYYMMDD');
begin
  if (select count(*) from public.health_series_5m) = 0 then raise exception 'FAIL: member cannot read own rows'; end if;
  if exists (select 1 from public.health_series_5m where user_id <> auth.uid())
     or exists (select 1 from public.health_series_1h where user_id <> auth.uid())
     or exists (select 1 from public.health_series_1d where user_id <> auth.uid())
     or exists (select 1 from public.health_observations where user_id <> auth.uid()) then
    raise exception 'FAIL: member sees another member''s rows';
  end if;
  if (select count(*) from public.health_codes) = 0 then raise exception 'FAIL: catalogue not readable'; end if;
  begin
    insert into public.health_series_5m (tenant_id, user_id, source_id, source_kind, source_rank, code_id, bucket_start, sum)
    values (gen_random_uuid(), auth.uid(), gen_random_uuid(), 'manual', 9, 1, date_trunc('hour', now()), 1);
    raise exception 'FAIL: member insert allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.health_observations set value = 1;
    raise exception 'FAIL: member update allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.health_series_1d;
    raise exception 'FAIL: member delete allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.health_ingest_batches;
    raise exception 'FAIL: member reads batches';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.health_ingest_quarantine;
    raise exception 'FAIL: member reads quarantine';
  exception when insufficient_privilege then null;
  end;
  begin
    execute format('select 1 from public.%I', v_part);
    raise exception 'FAIL: member reads a partition around the parent policy';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.health_store_ingest(gen_random_uuid(), auth.uid(), gen_random_uuid(), gen_random_uuid(), 'manual', 9::smallint, null, 'UTC', '[]', '[]');
    raise exception 'FAIL: member may execute health_store_ingest';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set role anon;
do $$ begin
  begin
    perform 1 from public.health_series_5m;
    raise exception 'FAIL: anon reads the store';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$
declare f text;
begin
  foreach f in array array['public.health_store_ensure_partitions(timestamptz)', 'public.health_store_partition_check(timestamptz)',
                           'public.health_store_purge(timestamptz)', 'public.health_store_suppress(uuid, text, uuid, timestamptz)',
                           'public.health_store_unsuppress(uuid, text, uuid)',
                           'public.health_store_ingest(uuid, uuid, uuid, uuid, text, smallint, uuid, text, jsonb, jsonb)',
                           'public.health_series_daily_resolved(uuid, smallint[], date, date)'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception 'FAIL: % executable by a browser role', f;
    end if;
    if not has_function_privilege('service_role', f, 'execute') then raise exception 'FAIL: service_role cannot execute %', f; end if;
    if not (select prosecdef from pg_proc where oid = f::regprocedure) then raise exception 'FAIL: % not SECURITY DEFINER', f; end if;
  end loop;
end $$;

-- ── 10. Suppress / unsuppress (per category and per source), RLS hides suppressed rows.
do $$
declare i record; r jsonb;
begin
  select * into i from t_ids;
  r := public.health_store_suppress(i.user_a, 'activity', null, now());
  if (r->>'health_series_5m')::int <> 3 or (r->>'health_series_1h')::int < 1 or (r->>'health_series_1d')::int < 1 then
    raise exception 'FAIL: suppress counts %', r;
  end if;
  if exists (select 1 from public.health_series_5m where user_id = i.user_a and code_id = 1 and suppressed_at is null) then
    raise exception 'FAIL: activity rows not suppressed';
  end if;
  if exists (select 1 from public.health_series_5m where user_id = i.user_a and code_id = 40 and suppressed_at is not null)
     or exists (select 1 from public.health_observations where user_id = i.user_a and suppressed_at is not null) then
    raise exception 'FAIL: other categories suppressed';
  end if;
  if exists (select 1 from public.health_series_5m where user_id = i.user_b and suppressed_at is not null) then
    raise exception 'FAIL: other member suppressed';
  end if;
  -- A write onto a suppressed key does not resurrect it.
  r := public.health_store_ingest(i.tenant, i.user_a, gen_random_uuid(), i.src_watch, 'device_cloud', 1::smallint, i.consent, 'UTC',
         jsonb_build_array(jsonb_build_object('code_id', 1, 'bucket_start', i.h10, 'sum', 999)), '[]');
  if (r->'counts'->>'suppressed')::int <> 1 then raise exception 'FAIL: write onto suppressed key %', r; end if;
  if (select r2.daily from (select count(*) as daily from public.health_series_daily_resolved(i.user_a, array[1]::smallint[], '2025-07-01', '2027-12-31')) r2) <> 0 then
    raise exception 'FAIL: resolver returns suppressed rows';
  end if;
end $$;

set role authenticated;
do $$ begin
  if exists (select 1 from public.health_series_5m where code_id = 1) or exists (select 1 from public.health_series_1d where code_id = 1) then
    raise exception 'FAIL: suppressed rows visible to the member';
  end if;
  if not exists (select 1 from public.health_series_5m where code_id = 40) then raise exception 'FAIL: unsuppressed rows hidden'; end if;
end $$;
reset role;

do $$
declare i record; r jsonb;
begin
  select * into i from t_ids;
  r := public.health_store_unsuppress(i.user_a, 'activity', i.src_phone);
  if exists (select 1 from public.health_series_1h where source_id = i.src_phone and suppressed_at is not null) then
    raise exception 'FAIL: unsuppress by source';
  end if;
  if not exists (select 1 from public.health_series_1h where source_id = i.src_watch and code_id = 1 and suppressed_at is not null) then
    raise exception 'FAIL: unsuppress touched another source';
  end if;
  r := public.health_store_unsuppress(i.user_a, null, null);
  if exists (select 1 from public.health_series_5m where user_id = i.user_a and suppressed_at is not null) then raise exception 'FAIL: unsuppress all'; end if;
  begin
    perform public.health_store_suppress(i.user_a, 'glucose', null, now());
    raise exception 'FAIL: unknown category accepted';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
end $$;

-- ── 11. Purge: expired 5-minute partitions only, batch/quarantine > 30 days,
--        suppressed > 7 days; one maintenance-run row.
do $$
declare
  i record; r jsonb; t text; v_old_day date := (now() at time zone 'UTC')::date - 45;
  v_runs int := (select count(*) from public.health_store_maintenance_runs);
begin
  select * into i from t_ids;
  -- An expired 5-minute partition (as if maintenance had stopped for weeks).
  execute format('create table public.%I partition of public.health_series_5m for values from (%L) to (%L)',
    'health_series_5m_p' || to_char(v_old_day, 'YYYYMMDD'),
    v_old_day::timestamp at time zone 'UTC', (v_old_day + 1)::timestamp at time zone 'UTC');
  -- Rows 40 and 1 day old (the 40-day-old month's partition is created here
  -- when ensure already skipped it as wholly expired).
  for t in select unnest(array['health_ingest_batches', 'health_ingest_quarantine']) loop
    if to_regclass('public.' || t || '_p' || to_char(now() - interval '40 days', 'YYYYMM')) is null then
      execute format('create table public.%I partition of public.%I for values from (%L) to (%L)',
        t || '_p' || to_char(now() - interval '40 days', 'YYYYMM'), t,
        case when t = 'health_ingest_batches' then (date_trunc('month', (now() - interval '40 days') at time zone 'UTC'))::date::text
             else ((date_trunc('month', (now() - interval '40 days') at time zone 'UTC')) at time zone 'UTC')::text end,
        case when t = 'health_ingest_batches' then (date_trunc('month', (now() - interval '40 days') at time zone 'UTC') + interval '1 month')::date::text
             else ((date_trunc('month', (now() - interval '40 days') at time zone 'UTC') + interval '1 month') at time zone 'UTC')::text end);
    end if;
  end loop;
  insert into public.health_ingest_batches (tenant_id, user_id, batch_id, body_sha256, source_id, via, received_at, received_month)
  values (i.tenant, i.user_a, gen_random_uuid(), 'old', i.src_watch, 'internal', now() - interval '40 days',
          (date_trunc('month', (now() - interval '40 days') at time zone 'UTC'))::date),
         (i.tenant, i.user_a, gen_random_uuid(), 'new', i.src_watch, 'internal', now() - interval '1 day',
          (date_trunc('month', (now() - interval '1 day') at time zone 'UTC'))::date);
  insert into public.health_ingest_quarantine (tenant_id, user_id, batch_id, item_index, reason, received_at)
  values (i.tenant, i.user_a, gen_random_uuid(), 0, 'FUTURE', now() - interval '40 days'),
         (i.tenant, i.user_a, gen_random_uuid(), 0, 'FUTURE', now() - interval '1 day');
  -- Suppressed 8 days ago (purged) and 1 day ago (kept).
  perform public.health_store_suppress(i.user_a, 'heart', null, now() - interval '8 days');
  perform public.health_store_suppress(i.user_a, 'body', null, now() - interval '1 day');

  r := public.health_store_purge(now());
  if to_regclass('public.health_series_5m_p' || to_char(v_old_day, 'YYYYMMDD')) is not null then
    raise exception 'FAIL: expired 5-minute partition kept';
  end if;
  if to_regclass('public.health_series_5m_p' || to_char((now() at time zone 'UTC')::date - 2, 'YYYYMMDD')) is null
     or to_regclass('public.health_series_5m_p' || to_char((now() at time zone 'UTC')::date, 'YYYYMMDD')) is null then
    raise exception 'FAIL: live 5-minute partition dropped';
  end if;
  if to_regclass('public.health_series_1h_p202507') is null then raise exception 'FAIL: purge dropped a lifetime partition'; end if;
  if exists (select 1 from public.health_ingest_batches where body_sha256 = 'old')
     or not exists (select 1 from public.health_ingest_batches where body_sha256 = 'new') then
    raise exception 'FAIL: batch retention';
  end if;
  if exists (select 1 from public.health_ingest_quarantine where received_at < now() - interval '30 days')
     or not exists (select 1 from public.health_ingest_quarantine where reason = 'FUTURE') then
    raise exception 'FAIL: quarantine retention';
  end if;
  if exists (select 1 from public.health_series_5m where user_id = i.user_a and code_id = 40) then
    raise exception 'FAIL: rows suppressed 8 days ago kept';
  end if;
  if not exists (select 1 from public.health_observations where user_id = i.user_a and code_id = 60 and suppressed_at is not null) then
    raise exception 'FAIL: rows suppressed 1 day ago purged';
  end if;
  if (select count(*) from public.health_store_maintenance_runs) <> v_runs + 1
     or (select finished_at is null or partitions_dropped < 1 or rows_purged < 3
           from public.health_store_maintenance_runs where run_id = (r->>'run_id')::uuid) then
    raise exception 'FAIL: maintenance run row %', r;
  end if;
  if exists (select 1 from public.health_store_partition_check(now())) then raise exception 'FAIL: purge broke tomorrow''s partitions'; end if;
  perform public.health_store_unsuppress(i.user_a, 'body', null);
end $$;

-- ── 12. erase_user_data() reaches every tier's partitions and the batch
--        tables, leaves member B, and none of the store tables is retained.
do $$
declare i record; r jsonb; t text; v_left boolean;
begin
  select * into i from t_ids;
  if exists (select 1 from public.erasure_registry where table_name like 'health\_%') then
    raise exception 'FAIL: a health store table is in erasure_registry';
  end if;
  r := public.erase_user_data(i.user_a, true);
  if coalesce((r->'deleted'->>'health_series_1h')::int, 0) = 0 or coalesce((r->'deleted'->>'health_observations')::int, 0) = 0 then
    raise exception 'FAIL: dry run did not count the store: %', r;
  end if;
  r := public.erase_user_data(i.user_a);
  if r->'errors' <> '{}'::jsonb then raise exception 'FAIL: erase errors %', r->'errors'; end if;
  foreach t in array array['health_series_5m','health_series_1h','health_series_1d','health_observations',
                           'health_ingest_batches','health_ingest_quarantine'] loop
    execute format('select exists (select 1 from public.%I where user_id = $1)', t) into v_left using i.user_a;
    if v_left then raise exception 'FAIL: erase left member A rows in %', t; end if;
    if not (r->'deleted') ? t then raise exception 'FAIL: erase did not report %: %', t, r; end if;
  end loop;
  if not exists (select 1 from public.health_series_5m where user_id = i.user_b)
     or not exists (select 1 from public.health_series_1h where user_id = i.user_b)
     or not exists (select 1 from public.health_series_1d where user_id = i.user_b)
     or not exists (select 1 from public.health_observations where user_id = i.user_b)
     or not exists (select 1 from public.health_ingest_batches where user_id = i.user_b)
     or not exists (select 1 from public.health_ingest_quarantine where user_id = i.user_b) then
    raise exception 'FAIL: erase touched member B';
  end if;
end $$;

\echo 'PASS vtid-05158 health store'
