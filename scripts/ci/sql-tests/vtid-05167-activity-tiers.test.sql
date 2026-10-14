-- VTID-05167: activity tiers (Life Timeline P1) against a synthetic schema on a
-- throwaway local Postgres. Never run against a shared or production database.
-- Run: scripts/ci/sql-tests/run-activity-tiers-test.sh
\set ON_ERROR_STOP on

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;

-- The two tables as production has them before the migration (2026-10-13):
-- the archive lacks `source` and still carries the 13-value allowlist.
create table public.user_activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  activity_type text not null,
  activity_data jsonb not null default '{}',
  context_data jsonb not null default '{}',
  session_id uuid,
  dedupe_key text,
  created_at timestamptz not null default now(),
  ingested_at timestamptz not null default now(),
  source text not null default 'frontend',
  actor_vitana_id text,
  constraint chk_activity_type check (activity_type ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,3}$')
);
create unique index idx_ual_dedupe on public.user_activity_log (user_id, dedupe_key) where dedupe_key is not null;
create table public.user_activity_log_archive (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  activity_type text not null,
  activity_data jsonb not null,
  context_data jsonb not null default '{}',
  session_id uuid,
  dedupe_key text,
  created_at timestamptz not null default now(),
  ingested_at timestamptz not null default now(),
  actor_vitana_id text,
  constraint chk_activity_type check (activity_type = any (array['chat.message','memory.create','calendar.create']))
);

-- Rows that exist before the migration (the backfill), newest first matters.
insert into public.user_activity_log (user_id, activity_type, created_at) values
  ('00000000-0000-0000-0000-000000000001', 'orb.livekit.next_action.candidate', now() - interval '1 minute'),
  ('00000000-0000-0000-0000-000000000001', 'page.view',                         now() - interval '2 minutes'),
  ('00000000-0000-0000-0000-000000000001', 'diary.create',                      now() - interval '3 minutes'),
  ('00000000-0000-0000-0000-000000000001', 'community.event.view',              now() - interval '4 minutes'),
  ('00000000-0000-0000-0000-000000000001', 'community.event.join',              now() - interval '5 minutes'),
  ('00000000-0000-0000-0000-000000000001', 'something.never_seen',              now() - interval '6 minutes'),
  ('00000000-0000-0000-0000-000000000001', 'page.view',                         now() - interval '200 days'),
  ('00000000-0000-0000-0000-000000000001', 'orb.navigator.requested',           now() - interval '201 days'),
  ('00000000-0000-0000-0000-000000000001', 'diary.create',                      now() - interval '202 days');

\ir ../../../supabase/migrations/20261014130000_vtid_05167_activity_tiers.sql
-- Idempotent: applying twice must succeed and change nothing.
\ir ../../../supabase/migrations/20261014130000_vtid_05167_activity_tiers.sql

do $$
declare
  n int;
  r record;
begin
  -- 1. Seed present and lookup: exact beats prefix, longest prefix wins, unknown is NULL.
  select count(*) into n from public.activity_catalog;
  if n < 100 then raise exception 'catalog seed too small: %', n; end if;
  if (public.activity_catalog_lookup('community.event.join')).topic <> 'event_rsvp' then raise exception 'exact lookup'; end if;
  if (public.activity_catalog_lookup('community.event.view')).tier <> 'silent' then raise exception 'prefix lookup community.event.'; end if;
  if (public.activity_catalog_lookup('orb.turn.received')).tier <> 'silent' then raise exception 'longest prefix orb.turn. must beat orb.'; end if;
  if (public.activity_catalog_lookup('orb.livekit.next_action.candidate')).tier <> 'system' then raise exception 'orb.livekit must be system'; end if;
  if (public.activity_catalog_lookup('something.never_seen')).activity_type is not null then raise exception 'unknown must be NULL'; end if;
  if (public.activity_catalog_lookup('health.log.water')).pillar <> 'hydration' then raise exception 'pillar lookup'; end if;

  -- 2. Before the backfill the existing rows are unclassified.
  select count(*) into n from public.user_activity_log where tier is null;
  if n <> 9 then raise exception 'expected 9 unclassified rows, got %', n; end if;

  -- 3. Backfill in batches, newest first, never deletes.
  if public.backfill_activity_tiers(2) <> 2 then raise exception 'first batch'; end if;
  select count(*) into n from public.user_activity_log
   where tier is not null and activity_type in ('orb.livekit.next_action.candidate','page.view') and created_at > now() - interval '1 hour';
  if n <> 2 then raise exception 'backfill must take the newest rows first'; end if;
  perform public.backfill_activity_tiers(100);
  if public.backfill_activity_tiers(100) <> 0 then raise exception 'backfill must report 0 when done'; end if;
  select count(*) into n from public.user_activity_log;
  if n <> 9 then raise exception 'backfill must not delete (rows=%)', n; end if;

  for r in select activity_type, tier, category, topic, pillar, secondary_pillar from public.user_activity_log loop
    if r.activity_type = 'orb.livekit.next_action.candidate' and r.tier <> 'system' then raise exception 'orb.livekit → system'; end if;
    if r.activity_type = 'page.view' and (r.tier <> 'silent' or r.category <> 'app_usage') then raise exception 'page.view → silent/app_usage'; end if;
    if r.activity_type = 'diary.create' and (r.tier <> 'moment' or r.secondary_pillar <> 'mental') then raise exception 'diary.create → moment, mental'; end if;
    if r.activity_type = 'community.event.join' and r.tier <> 'moment' then raise exception 'event join → moment'; end if;
    if r.activity_type = 'something.never_seen' and (r.tier <> 'silent' or r.topic <> 'unknown') then raise exception 'unknown → silent/unknown'; end if;
  end loop;

  -- 4. Trigger on insert: classifies frontend rows, never overwrites provided values.
  insert into public.user_activity_log (user_id, activity_type) values ('00000000-0000-0000-0000-000000000002', 'health.log.water');
  select tier, category, pillar into r from public.user_activity_log where user_id = '00000000-0000-0000-0000-000000000002';
  if r.tier <> 'moment' or r.category <> 'hydration' or r.pillar <> 'hydration' then raise exception 'trigger classify: %', r; end if;
  insert into public.user_activity_log (user_id, activity_type, tier, category, topic, pillar)
    values ('00000000-0000-0000-0000-000000000003', 'page.view', 'moment', 'goals', 'custom', 'sleep');
  select tier, category, topic, pillar into r from public.user_activity_log where user_id = '00000000-0000-0000-0000-000000000003';
  if r.tier <> 'moment' or r.category <> 'goals' or r.topic <> 'custom' or r.pillar <> 'sleep' then raise exception 'trigger overwrote provided values: %', r; end if;

  -- 5. Constraints.
  begin
    insert into public.user_activity_log (user_id, activity_type, tier) values ('00000000-0000-0000-0000-000000000004', 'page.view', 'loud');
    raise exception 'bad tier accepted';
  exception when check_violation then null; end;
  begin
    insert into public.user_activity_log (user_id, activity_type, pillar) values ('00000000-0000-0000-0000-000000000004', 'page.view', 'social');
    raise exception 'bad pillar accepted';
  exception when check_violation then null; end;

  -- 6. Archive: only silent/system older than 180 days move; moments stay.
  perform public.archive_old_activity_logs();
  select count(*) into n from public.user_activity_log_archive;
  if n <> 2 then raise exception 'archive must move exactly the 2 old silent/system rows, moved %', n; end if;
  if exists (select 1 from public.user_activity_log_archive where activity_type = 'diary.create') then raise exception 'a moment was archived'; end if;
  if not exists (select 1 from public.user_activity_log where activity_type = 'diary.create' and created_at < now() - interval '180 days') then raise exception 'old moment must stay'; end if;
  if exists (select 1 from public.user_activity_log where created_at < now() - interval '180 days' and tier in ('silent','system')) then raise exception 'old silent/system rows still in the main table'; end if;
  if (select tier from public.user_activity_log_archive where activity_type = 'page.view') <> 'silent' then raise exception 'archive must keep the tier'; end if;

  -- 7. Privileges: members cannot run the definer functions; they can read the catalog.
  if has_function_privilege('authenticated', 'public.backfill_activity_tiers(int)', 'execute') then raise exception 'authenticated can run backfill'; end if;
  if has_function_privilege('authenticated', 'public.archive_old_activity_logs()', 'execute') then raise exception 'authenticated can run archive'; end if;
  if has_function_privilege('anon', 'public.archive_old_activity_logs()', 'execute') then raise exception 'anon can run archive'; end if;
  if not has_table_privilege('authenticated', 'public.activity_catalog', 'select') then raise exception 'authenticated cannot read the catalog'; end if;
  if has_table_privilege('authenticated', 'public.activity_catalog', 'insert') then raise exception 'authenticated can write the catalog'; end if;
  if has_table_privilege('anon', 'public.activity_catalog', 'select') then raise exception 'anon can read the catalog'; end if;
end $$;

\echo 'PASS vtid-05167 activity tiers'
