-- VTID-04915: community event host entry + time/place sync + delete cancel,
-- on a throwaway local Postgres. Never run against a shared or production
-- database. Run: scripts/ci/sql-tests/run-community-event-calendar-test.sh
\set ON_ERROR_STOP on

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

-- Minimal stand-ins for the live tables (only the columns the triggers use).
create table public.global_community_events (
  id uuid primary key default gen_random_uuid(),
  title text, description text, event_type text,
  start_time timestamptz, end_time timestamptz,
  location text, virtual_link text, created_by uuid, slug text,
  metadata jsonb default '{}'::jsonb
);
create table public.global_event_participants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.global_community_events(id) on delete cascade,
  user_id uuid, status text
);
create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null, title text, description text,
  start_time timestamptz, end_time timestamptz, location text,
  event_type text, source_type text, source_ref_id text, source_ref_type text,
  status text default 'confirmed', role_context text,
  metadata jsonb default '{}'::jsonb, updated_at timestamptz default now()
);
create unique index idx_calendar_events_source_ref
  on public.calendar_events (user_id, source_ref_id, source_ref_type) where source_ref_id is not null;

-- The VTID-04321 attendee trigger it works next to, then this migration twice (idempotent).
\ir ../../../supabase/migrations/20260923120000_vtid_04321_rsvp_calendar_global_events.sql
\ir ../../../supabase/migrations/20261006140000_vtid_04915_community_event_host_and_time_sync.sql
\ir ../../../supabase/migrations/20261006140000_vtid_04915_community_event_host_and_time_sync.sql

do $$
declare
  host uuid := gen_random_uuid();
  guest uuid := gen_random_uuid();
  other uuid := gen_random_uuid();
  ev uuid; ev2 uuid; unrelated uuid; n int; r record;
begin
  -- 1. Creating an event gives the host one entry, marked host, same shape as RSVP rows.
  insert into public.global_community_events (title, start_time, end_time, location, created_by, slug)
    values ('Morning walk', now() + interval '2 days', now() + interval '2 days 1 hour', 'Park', host, 'morning-walk')
    returning id into ev;
  select count(*) into n from public.calendar_events where user_id = host and source_ref_id = ev::text;
  assert n = 1, 'host gets exactly one entry';
  select * into r from public.calendar_events where user_id = host and source_ref_id = ev::text;
  assert r.source_type = 'community_rsvp' and r.source_ref_type = 'community_event', 'host entry is a community_event ref';
  assert r.metadata->>'meetup_id' = ev::text and (r.metadata->>'host')::boolean, 'host entry carries meetup_id and host=true';
  assert r.location = 'Park' and r.status = 'confirmed', 'host entry copies location, confirmed';

  -- An event with no start time or no creator creates nothing.
  insert into public.global_community_events (title, start_time, created_by) values ('No time', null, host);
  insert into public.global_community_events (title, start_time, created_by) values ('No host', now() + interval '1 day', null);
  select count(*) into n from public.calendar_events where title in ('No time', 'No host');
  assert n = 0, 'no entry without start time or creator';

  -- 2. An attendee joins (VTID-04321 trigger). Another user has a client-written row (legacy shape).
  insert into public.global_event_participants (event_id, user_id, status) values (ev, guest, 'attending');
  insert into public.calendar_events (user_id, title, start_time, end_time, source_type, metadata)
    values (other, 'Morning walk', now() + interval '2 days', now() + interval '2 days 1 hour', 'manual',
            jsonb_build_object('meetup_id', ev::text));
  -- An unrelated entry that must never move.
  insert into public.global_community_events (title, start_time, created_by) values ('Other', now() + interval '5 days', other)
    returning id into unrelated;

  -- 3. Moving the event moves host, attendee and legacy client rows; nothing else.
  update public.global_community_events
     set start_time = now() + interval '3 days', end_time = null, location = null, virtual_link = 'https://meet.example/x', title = 'Evening walk'
   where id = ev;
  select count(*) into n from public.calendar_events
   where (source_ref_id = ev::text or metadata->>'meetup_id' = ev::text)
     and title = 'Evening walk' and location = 'https://meet.example/x'
     and start_time > now() + interval '2 days 23 hours'
     and end_time = start_time + interval '1 hour';
  assert n = 3, format('host, attendee and legacy row all moved (got %s)', n);
  select count(*) into n from public.calendar_events where source_ref_id = unrelated::text and title = 'Other';
  assert n = 1, 'unrelated event entry untouched';

  -- An update that changes nothing relevant does not touch entries.
  update public.calendar_events set updated_at = '2000-01-01' where source_ref_id = ev::text or metadata->>'meetup_id' = ev::text;
  update public.global_community_events set metadata = '{"x":1}' where id = ev;
  update public.global_community_events set title = title where id = ev;
  select count(*) into n from public.calendar_events
   where (source_ref_id = ev::text or metadata->>'meetup_id' = ev::text) and updated_at = '2000-01-01';
  assert n = 3, 'no-op or unrelated column update does not rewrite entries';

  -- A cancelled entry is not revived by a move.
  update public.calendar_events set status = 'cancelled' where user_id = guest and source_ref_id = ev::text;
  update public.global_community_events set start_time = now() + interval '4 days' where id = ev;
  select status into r from public.calendar_events where user_id = guest and source_ref_id = ev::text;
  assert r.status = 'cancelled', 'cancelled entry stays cancelled';

  -- 4. A client-written host row arriving after the trigger replaces it (VTID-04321 dedupe), still one row.
  insert into public.global_community_events (title, start_time, created_by, slug) values ('Yoga', now() + interval '1 day', host, 'yoga')
    returning id into ev2;
  insert into public.calendar_events (user_id, title, start_time, source_type, metadata)
    values (host, 'Yoga', now() + interval '1 day', 'manual', jsonb_build_object('meetup_id', ev2::text));
  select count(*) into n from public.calendar_events
   where user_id = host and status <> 'cancelled' and (source_ref_id = ev2::text or metadata->>'meetup_id' = ev2::text);
  assert n = 1, 'host has one live entry after the client row arrives';

  -- 5. Deleting the event cancels every live entry for it, and nothing else.
  delete from public.global_community_events where id = ev;
  select count(*) into n from public.calendar_events
   where (source_ref_id = ev::text or metadata->>'meetup_id' = ev::text) and status <> 'cancelled';
  assert n = 0, 'all entries cancelled on delete';
  select count(*) into n from public.calendar_events where source_ref_id = unrelated::text and status = 'confirmed';
  assert n = 1, 'unrelated entry still confirmed';

  -- 6. Privileges: the function is not callable by clients.
  assert not has_function_privilege('authenticated', 'public.fn_community_event_to_calendar()', 'execute'), 'authenticated cannot execute';
  assert not has_function_privilege('anon', 'public.fn_community_event_to_calendar()', 'execute'), 'anon cannot execute';
end $$;

-- 7. Backfill: re-applying the migration gives a future event's host an entry once, past events none.
do $$
declare h uuid := gen_random_uuid(); fut uuid; past uuid;
begin
  alter table public.global_community_events disable trigger trg_community_event_host_calendar;
  insert into public.global_community_events (title, start_time, created_by) values ('Future', now() + interval '7 days', h) returning id into fut;
  insert into public.global_community_events (title, start_time, created_by) values ('Past', now() - interval '7 days', h) returning id into past;
  alter table public.global_community_events enable trigger trg_community_event_host_calendar;
end $$;
\ir ../../../supabase/migrations/20261006140000_vtid_04915_community_event_host_and_time_sync.sql
\ir ../../../supabase/migrations/20261006140000_vtid_04915_community_event_host_and_time_sync.sql
do $$
declare n int;
begin
  select count(*) into n from public.calendar_events where title = 'Future';
  assert n = 1, format('future host backfilled once (got %s)', n);
  select count(*) into n from public.calendar_events where title = 'Past';
  assert n = 0, 'past event not backfilled';
end $$;

\echo 'PASS vtid-04915 community event calendar'
