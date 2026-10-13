-- VTID-05171: companion wiring (Life Timeline P5) against a synthetic schema on
-- a throwaway local Postgres. Never run against a shared or production database.
-- Run: scripts/ci/sql-tests/run-companion-wiring-test.sh
\set ON_ERROR_STOP on

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;

-- Minimal Supabase auth surface.
create schema if not exists auth;
create table auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
insert into auth.users values ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b');

-- user_routines exactly as VTID-01936 created it.
\ir ../../../supabase/migrations/20260419120000_user_routines.sql
insert into public.user_routines (user_id, routine_kind, routine_key, title, summary)
values ('00000000-0000-0000-0000-00000000000a', 'day_of_week_rhythm', 'sunday', 'Sunday diary', 'existing row');

\ir ../../../supabase/migrations/20261014150000_vtid_05171_companion_wiring.sql
-- Idempotent: applying twice must succeed.
\ir ../../../supabase/migrations/20261014150000_vtid_05171_companion_wiring.sql

do $$
declare n int;
begin
  -- 1. the four new kinds are accepted, the old ones still are, anything else is not.
  insert into public.user_routines (user_id, routine_kind, routine_key, title, summary) values
    ('00000000-0000-0000-0000-00000000000a', 'screen_habit', '/community', 't', 's'),
    ('00000000-0000-0000-0000-00000000000a', 'active_hours', 'overall', 't', 's'),
    ('00000000-0000-0000-0000-00000000000a', 'feature_affinity', 'community', 't', 's'),
    ('00000000-0000-0000-0000-00000000000a', 'pillar_rhythm', 'sleep', 't', 's'),
    ('00000000-0000-0000-0000-00000000000a', 'completion_streak', 'diary', 't', 's');
  begin
    insert into public.user_routines (user_id, routine_kind, routine_key, title, summary)
      values ('00000000-0000-0000-0000-00000000000a', 'page_spy', 'x', 't', 's');
    raise exception 'FAIL: unknown routine kind accepted';
  exception when check_violation then null;
  end;
  select count(*) into n from public.user_routines where routine_kind = 'day_of_week_rhythm';
  if n <> 1 then raise exception 'FAIL: existing routine lost'; end if;

  -- 2. learning prefs: defaults + category list.
  insert into public.timeline_learning_prefs (user_id, category) values ('00000000-0000-0000-0000-00000000000b', 'diary');
  select count(*) into n from public.timeline_learning_prefs where learn = true;
  if n <> 1 then raise exception 'FAIL: learn does not default to true'; end if;
  begin
    insert into public.timeline_learning_prefs (user_id, category) values ('00000000-0000-0000-0000-00000000000b', 'system');
    raise exception 'FAIL: category system accepted';
  exception when check_violation then null;
  end;

  -- 3. privileges: anon has none.
  if has_table_privilege('anon', 'public.timeline_learning_prefs', 'select') then raise exception 'FAIL: anon can read prefs'; end if;
  if not has_table_privilege('authenticated', 'public.timeline_learning_prefs', 'insert') then raise exception 'FAIL: authenticated cannot write own prefs'; end if;
end $$;

-- 4. RLS: a member sees and writes only their own switches.
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
insert into public.timeline_learning_prefs (user_id, category, learn) values ('00000000-0000-0000-0000-00000000000a', 'app_usage', false);
do $$
declare n int;
begin
  select count(*) into n from public.timeline_learning_prefs;
  if n <> 1 then raise exception 'FAIL: member sees % pref rows, expected only their own', n; end if;
  begin
    insert into public.timeline_learning_prefs (user_id, category) values ('00000000-0000-0000-0000-00000000000b', 'community');
    raise exception 'FAIL: member wrote another member''s switch';
  exception when insufficient_privilege then null;
  end;
  update public.timeline_learning_prefs set learn = true where user_id = '00000000-0000-0000-0000-00000000000b';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: member updated another member''s switch'; end if;
end $$;
reset role;

\echo 'PASS vtid-05171 companion wiring'
