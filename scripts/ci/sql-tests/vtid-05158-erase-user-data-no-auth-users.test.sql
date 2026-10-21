-- VTID-05158: erase_user_data() on a database WITHOUT auth.users (Aurora,
-- scripts/aurora/migrations/0001_auth_shim.sql). Before the fix the cast
-- 'auth.users'::regclass raised `relation "auth.users" does not exist` and
-- every call failed. Throwaway local Postgres only.
-- Run: scripts/ci/sql-tests/run-erase-user-data-test.sh
\set ON_ERROR_STOP on
set client_min_messages = warning;

-- Roles only: no auth schema at all.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
do $$ begin
  if to_regclass('auth.users') is not null then raise exception 'FAIL: this test needs a database without auth.users'; end if;
end $$;

\ir ../../../supabase/migrations/20261001120000_vtid_04765_erase_user_data.sql
\ir ../../../supabase/migrations/20261014100000_vtid_05158_erase_user_data_aurora_safe.sql

-- Plain table and partitioned table (rows live in partitions).
create table public.memory_facts (id serial primary key, user_id uuid not null, fact_value text);
insert into public.memory_facts (user_id, fact_value) values
  ('00000000-0000-0000-0000-00000000000a', 'a1'), ('00000000-0000-0000-0000-00000000000a', 'a2'),
  ('00000000-0000-0000-0000-00000000000b', 'b1');
create table public.health_like (user_id uuid not null, at date not null) partition by range (at);
create table public.health_like_p1 partition of public.health_like for values from ('2026-01-01') to ('2026-07-01');
create table public.health_like_p2 partition of public.health_like for values from ('2026-07-01') to ('2027-01-01');
insert into public.health_like values
  ('00000000-0000-0000-0000-00000000000a', '2026-02-01'), ('00000000-0000-0000-0000-00000000000a', '2026-08-01'),
  ('00000000-0000-0000-0000-00000000000b', '2026-08-01');
create table public.wallet_ledger_entries (id int primary key, user_id uuid);
insert into public.wallet_ledger_entries values (1, '00000000-0000-0000-0000-00000000000a');

do $$
declare r jsonb; a uuid := '00000000-0000-0000-0000-00000000000a'; b uuid := '00000000-0000-0000-0000-00000000000b';
begin
  if not has_function_privilege('service_role', 'public.erase_user_data(uuid, boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.erase_user_data(uuid, boolean)', 'execute')
     or has_function_privilege('anon', 'public.erase_user_data(uuid, boolean)', 'execute') then
    raise exception 'FAIL: grants changed';
  end if;

  r := public.erase_user_data(a, true);
  if (r->'deleted'->>'memory_facts')::int <> 2 or (r->'deleted'->>'health_like')::int <> 2 then raise exception 'FAIL: dry run %', r; end if;
  if r->'errors' <> '{}'::jsonb then raise exception 'FAIL: dry run errors %', r->'errors'; end if;
  if (select count(*) from public.memory_facts where user_id = a) <> 2 then raise exception 'FAIL: dry run deleted rows'; end if;

  r := public.erase_user_data(a);
  if r->'errors' <> '{}'::jsonb then raise exception 'FAIL: errors %', r->'errors'; end if;
  if exists (select 1 from public.memory_facts where user_id = a) then raise exception 'FAIL: plain table kept A'; end if;
  if exists (select 1 from public.health_like where user_id = a) then raise exception 'FAIL: partitioned table kept A'; end if;
  if not exists (select 1 from public.wallet_ledger_entries where user_id = a) then raise exception 'FAIL: retained table erased'; end if;
  if (select count(*) from public.memory_facts where user_id = b) <> 1 or (select count(*) from public.health_like where user_id = b) <> 1 then
    raise exception 'FAIL: user B touched';
  end if;
end $$;

\echo 'PASS vtid-05158 erase_user_data without auth.users'
