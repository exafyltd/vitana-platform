-- VTID-04765: erase_user_data() against a synthetic schema on a throwaway
-- local Postgres. Never run against a shared or production database.
-- Run: scripts/ci/sql-tests/run-erase-user-data-test.sh
\set ON_ERROR_STOP on

-- Supabase shapes the migration relies on.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);

\ir ../../../supabase/migrations/20261001120000_vtid_04765_erase_user_data.sql

-- Users: A is erased, B must be untouched.
insert into auth.users values ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b');

-- 1. Plain memory table, no FK (the real gap).
create table public.memory_facts (id serial primary key, user_id uuid not null, fact_value text);
insert into public.memory_facts (user_id, fact_value) values
  ('00000000-0000-0000-0000-00000000000a', 'a1'), ('00000000-0000-0000-0000-00000000000a', 'a2'),
  ('00000000-0000-0000-0000-00000000000b', 'b1');

-- 2. FK ordering: "aaa_parent" sorts first but is referenced by "zzz_child".
create table public.aaa_parent (id int primary key, user_id uuid);
create table public.zzz_child (id int primary key, user_id uuid, parent_id int references public.aaa_parent(id));
insert into public.aaa_parent values (1, '00000000-0000-0000-0000-00000000000a'), (2, '00000000-0000-0000-0000-00000000000b');
insert into public.zzz_child values (1, '00000000-0000-0000-0000-00000000000a', 1), (2, '00000000-0000-0000-0000-00000000000b', 2);

-- 3. Partitioned table: rows live in partitions, deleted via the parent.
create table public.memory_audit_log (id int, user_id uuid, at date) partition by range (at);
create table public.memory_audit_log_y2026 partition of public.memory_audit_log for values from ('2026-01-01') to ('2027-01-01');
insert into public.memory_audit_log values (1, '00000000-0000-0000-0000-00000000000a', '2026-05-01'), (2, '00000000-0000-0000-0000-00000000000b', '2026-05-01');

-- 4. A delete trigger that writes a new row for the same user (audit pattern).
create table public.diary_entries (id int primary key, user_id uuid);
create table public.diary_audit (id serial primary key, user_id uuid, note text);
create function public.diary_audit_trg() returns trigger language plpgsql as $$
begin insert into public.diary_audit (user_id, note) values (old.user_id, 'deleted'); return old; end $$;
create trigger diary_audit_after_delete after delete on public.diary_entries for each row execute function public.diary_audit_trg();
insert into public.diary_entries values (1, '00000000-0000-0000-0000-00000000000a'), (2, '00000000-0000-0000-0000-00000000000b');

-- 5. Retained by law.
create table public.wallet_ledger_entries (id int primary key, user_id uuid);
insert into public.wallet_ledger_entries values (1, '00000000-0000-0000-0000-00000000000a');

-- 6. Not a uuid user_id: out of scope.
create table public.legacy_text_ids (id int primary key, user_id text);
insert into public.legacy_text_ids values (1, '00000000-0000-0000-0000-00000000000a');

-- 7. A table whose delete always fails: reported, not swallowed, rest goes on.
create table public.locked_rows (id int primary key, user_id uuid);
create function public.locked_rows_trg() returns trigger language plpgsql as $$
begin raise exception 'locked by policy'; end $$;
create trigger locked_rows_before_delete before delete on public.locked_rows for each row execute function public.locked_rows_trg();
insert into public.locked_rows values (1, '00000000-0000-0000-0000-00000000000a');

-- 8. Cascading table is left to the auth delete, even when a table without
--    user_id references it (wallet_transactions -> profiles in production).
create table public.profiles (id int primary key, user_id uuid references auth.users(id) on delete cascade);
insert into public.profiles values (1, '00000000-0000-0000-0000-00000000000a');
create table public.wallet_transactions (id int primary key, profile_id int references public.profiles(id));
insert into public.wallet_transactions values (1, 1);

-- Permissions: only service_role may execute.
do $$ begin
  if has_function_privilege('anon', 'public.erase_user_data(uuid, boolean)', 'execute') then raise exception 'FAIL: anon can execute'; end if;
  if has_function_privilege('authenticated', 'public.erase_user_data(uuid, boolean)', 'execute') then raise exception 'FAIL: authenticated can execute'; end if;
  if not has_function_privilege('service_role', 'public.erase_user_data(uuid, boolean)', 'execute') then raise exception 'FAIL: service_role cannot execute'; end if;
end $$;

-- Dry run counts and deletes nothing.
do $$
declare r jsonb;
begin
  r := public.erase_user_data('00000000-0000-0000-0000-00000000000a', true);
  if (r->'deleted'->>'memory_facts')::int <> 2 then raise exception 'FAIL dry run count: %', r; end if;
  if (select count(*) from public.memory_facts where user_id = '00000000-0000-0000-0000-00000000000a') <> 2 then raise exception 'FAIL: dry run deleted rows'; end if;
end $$;

-- Real run.
do $$
declare r jsonb; a uuid := '00000000-0000-0000-0000-00000000000a'; b uuid := '00000000-0000-0000-0000-00000000000b';
begin
  r := public.erase_user_data(a);
  raise notice 'result: %', r;

  if exists (select 1 from public.memory_facts where user_id = a) then raise exception 'FAIL: memory_facts kept A'; end if;
  if exists (select 1 from public.zzz_child where user_id = a) then raise exception 'FAIL: child kept A'; end if;
  if exists (select 1 from public.aaa_parent where user_id = a) then raise exception 'FAIL: parent kept A (FK retry)'; end if;
  if exists (select 1 from public.memory_audit_log where user_id = a) then raise exception 'FAIL: partition kept A'; end if;
  if exists (select 1 from public.diary_entries where user_id = a) then raise exception 'FAIL: diary kept A'; end if;
  if exists (select 1 from public.diary_audit where user_id = a) then raise exception 'FAIL: trigger-written audit row survived the sweep'; end if;
  if not exists (select 1 from public.profiles where user_id = a) then raise exception 'FAIL: cascading table touched'; end if;
  if (r->'errors') ? 'profiles' then raise exception 'FAIL: cascading table attempted'; end if;

  if not exists (select 1 from public.wallet_ledger_entries where user_id = a) then raise exception 'FAIL: retained table was erased'; end if;
  if not (r->'retained') ? 'wallet_ledger_entries' then raise exception 'FAIL: retained not reported: %', r; end if;
  if not exists (select 1 from public.legacy_text_ids) then raise exception 'FAIL: text user_id table touched'; end if;

  if not (r->'errors') ? 'locked_rows' then raise exception 'FAIL: failing table not reported: %', r; end if;
  if (select count(*) from jsonb_object_keys(r->'errors')) <> 1 then raise exception 'FAIL: unexpected errors: %', r->'errors'; end if;
  if (r->'errors') ? 'aaa_parent' then raise exception 'FAIL: resolved FK still reported'; end if;

  if (select count(*) from public.memory_facts where user_id = b) <> 1
     or (select count(*) from public.aaa_parent where user_id = b) <> 1
     or (select count(*) from public.zzz_child where user_id = b) <> 1
     or (select count(*) from public.memory_audit_log where user_id = b) <> 1
     or (select count(*) from public.diary_entries where user_id = b) <> 1
  then raise exception 'FAIL: user B rows were touched'; end if;

  begin
    perform public.erase_user_data(null);
    raise exception 'FAIL: null user accepted';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
end $$;

\echo 'PASS vtid-04765 erase_user_data'
