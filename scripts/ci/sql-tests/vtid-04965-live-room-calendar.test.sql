-- VTID-04965: Live Room reminder -> calendar entry, on a throwaway local
-- Postgres. Never run against a shared or production database.
-- Run: scripts/ci/sql-tests/run-live-room-calendar-test.sh
\set ON_ERROR_STOP on

create table public.community_live_streams (
  id uuid primary key default gen_random_uuid(),
  title text, description text, status text, scheduled_for timestamptz, duration_minutes int
);
create table public.live_stream_subscribers (
  id uuid primary key default gen_random_uuid(),
  stream_id uuid not null references public.community_live_streams(id) on delete cascade,
  user_id uuid not null, unique (stream_id, user_id)
);
create table public.service_bot_accounts (user_id uuid primary key);
create table public.notification_test_actors (user_id uuid primary key);
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

-- Pre-existing subscribers (before the migration) for the backfill.
do $$
declare u1 uuid := gen_random_uuid(); bot uuid := gen_random_uuid(); fut uuid; past uuid; n int;
begin
  insert into public.community_live_streams (title, status, scheduled_for) values ('Backfill future', 'pending', now() + interval '3 days') returning id into fut;
  insert into public.community_live_streams (title, status, scheduled_for) values ('Backfill past', 'pending', now() - interval '3 days') returning id into past;
  insert into public.service_bot_accounts values (bot);
  insert into public.live_stream_subscribers (stream_id, user_id) values (fut, u1), (fut, bot), (past, u1);
end $$;

\ir ../../../supabase/migrations/20261007200000_vtid_04965_live_room_reminder_calendar.sql
\ir ../../../supabase/migrations/20261007200000_vtid_04965_live_room_reminder_calendar.sql

do $$
declare n int;
begin
  select count(*) into n from public.calendar_events where title = 'Backfill future';
  assert n = 1, format('backfill: one row for the real member, none for the bot, no duplicate on re-run (got %s)', n);
  select count(*) into n from public.calendar_events where title = 'Backfill past';
  assert n = 0, 'backfill: a past room gets nothing';
end $$;

do $$
declare
  member uuid := gen_random_uuid(); bot uuid := gen_random_uuid(); tester uuid := gen_random_uuid();
  room uuid; room2 uuid; started uuid; nodate uuid; r record; n int;
begin
  insert into public.service_bot_accounts values (bot);
  insert into public.notification_test_actors values (tester);

  -- 1. Erinnern on a pending future room: one entry, live_room shape, 90 min long.
  insert into public.community_live_streams (title, description, status, scheduled_for, duration_minutes)
    values ('Song release', 'Party', 'pending', now() + interval '2 days', 90) returning id into room;
  insert into public.live_stream_subscribers (stream_id, user_id) values (room, member);
  select * into r from public.calendar_events where user_id = member and source_ref_id = room::text;
  assert r.source_type = 'live_room' and r.source_ref_type = 'live_room', 'entry is a live_room ref';
  assert r.event_type = 'community' and r.status = 'confirmed' and r.location = 'Virtual', 'community, confirmed, virtual';
  assert r.end_time - r.start_time = interval '90 minutes', 'ends after duration_minutes';
  assert r.metadata->>'live_room_id' = room::text, 'carries the room id';

  -- 2. No duration -> 60 minutes.
  insert into public.community_live_streams (title, status, scheduled_for) values ('No duration', 'pending', now() + interval '1 day') returning id into room2;
  insert into public.live_stream_subscribers (stream_id, user_id) values (room2, member);
  select * into r from public.calendar_events where user_id = member and source_ref_id = room2::text;
  assert r.end_time - r.start_time = interval '60 minutes', 'default 60 minutes';

  -- 3. Not pending / no date / already started -> nothing.
  insert into public.community_live_streams (title, status, scheduled_for) values ('Live now', 'live', now() + interval '1 day') returning id into started;
  insert into public.community_live_streams (title, status, scheduled_for) values ('No date', 'pending', null) returning id into nodate;
  insert into public.live_stream_subscribers (stream_id, user_id) values (started, member), (nodate, member);
  select count(*) into n from public.calendar_events where user_id = member and source_ref_id in (started::text, nodate::text);
  assert n = 0, 'only pending rooms with a future date reach the calendar';

  -- 4. Test and service accounts never get a row.
  insert into public.live_stream_subscribers (stream_id, user_id) values (room, bot), (room, tester);
  select count(*) into n from public.calendar_events where user_id in (bot, tester);
  assert n = 0, 'bot and test accounts get no entry';

  -- 5. Erinnern off cancels; on again revives the same row; no duplicate.
  delete from public.live_stream_subscribers where stream_id = room and user_id = member;
  select status into r from public.calendar_events where user_id = member and source_ref_id = room::text;
  assert r.status = 'cancelled', 'unsubscribe cancels the entry';
  insert into public.live_stream_subscribers (stream_id, user_id) values (room, member);
  select count(*) into n from public.calendar_events where user_id = member and source_ref_id = room::text;
  assert n = 1, 'resubscribe never duplicates';
  select status into r from public.calendar_events where user_id = member and source_ref_id = room::text;
  assert r.status = 'confirmed', 'resubscribe revives the entry';

  -- 6. Unsubscribing never touches another room's or another member's entry.
  delete from public.live_stream_subscribers where stream_id = room2 and user_id = member;
  select count(*) into n from public.calendar_events where user_id = member and status = 'confirmed' and source_ref_id = room::text;
  assert n = 1, 'other rooms untouched';
end $$;

\echo 'PASS vtid-04965 live room calendar'
