-- VTID-04976: a live room's calendar entries follow the room (host entry,
-- reschedule/cancel/delete, host survives un-notify), on a throwaway local
-- Postgres. Never run against a shared or production database.
-- Run: scripts/ci/sql-tests/run-live-room-host-calendar-test.sh
\set ON_ERROR_STOP on

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

create table public.community_live_streams (
  id uuid primary key default gen_random_uuid(),
  title text, description text, status text, scheduled_for timestamptz,
  duration_minutes int, created_by uuid, viewer_count int default 0
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

-- Before the migration: a room whose host tapped Erinnern under the old rule
-- and then un-notified (cancelled host row), a room with an Erinnern-first
-- host (live row), a past room, and a room by a bot host.
do $$
declare h1 uuid := gen_random_uuid(); h2 uuid := gen_random_uuid(); bot uuid := gen_random_uuid();
        s1 uuid; s2 uuid; s3 uuid; s4 uuid;
begin
  insert into public.service_bot_accounts values (bot);
  insert into public.community_live_streams (title, status, scheduled_for, created_by) values ('Backfill revive', 'pending', now() + interval '3 days', h1) returning id into s1;
  insert into public.community_live_streams (title, status, scheduled_for, created_by) values ('Backfill merge', 'pending', now() + interval '4 days', h2) returning id into s2;
  insert into public.community_live_streams (title, status, scheduled_for, created_by) values ('Backfill past', 'pending', now() - interval '2 days', h1) returning id into s3;
  insert into public.community_live_streams (title, status, scheduled_for, created_by) values ('Backfill bot', 'pending', now() + interval '2 days', bot) returning id into s4;
  insert into public.calendar_events (user_id, title, start_time, end_time, event_type, source_type, source_ref_id, source_ref_type, status, role_context, metadata)
    values (h1, 'old title', now() + interval '1 day', now() + interval '1 day 1 hour', 'community', 'live_room', s1::text, 'live_room', 'cancelled', 'community', '{}'::jsonb),
           (h2, 'Backfill merge', now() + interval '4 days', now() + interval '4 days 1 hour', 'community', 'live_room', s2::text, 'live_room', 'confirmed', 'community', '{"live_room_id":"x"}'::jsonb);
end $$;

-- The VTID-04965 migration is the base the new one replaces functions of.
\ir ../../../supabase/migrations/20261007200000_vtid_04965_live_room_reminder_calendar.sql
\ir ../../../supabase/migrations/20261008130000_vtid_04976_live_room_follows_host.sql
\ir ../../../supabase/migrations/20261008130000_vtid_04976_live_room_follows_host.sql

do $$
declare r record; n int;
begin
  select * into r from public.calendar_events where title = 'Backfill revive';
  assert r.status = 'confirmed' and (r.metadata->>'host')::boolean, 'backfill revives a cancelled host row and marks it host';
  assert r.start_time > now() + interval '2 days', 'backfill moves the revived row to the room''s current time';
  select * into r from public.calendar_events where title = 'Backfill merge';
  assert (r.metadata->>'host')::boolean and r.status = 'confirmed', 'backfill merges host=true into an existing live row';
  select count(*) into n from public.calendar_events where source_ref_id in (select id::text from public.community_live_streams where title in ('Backfill revive','Backfill merge'));
  assert n = 2, format('backfill: one row per host, no duplicate after re-run (got %s)', n);
  select count(*) into n from public.calendar_events where source_ref_id in (select id::text from public.community_live_streams where title in ('Backfill past','Backfill bot'));
  assert n = 0, 'backfill: past room and bot host get nothing';
end $$;

do $$
declare
  host uuid := gen_random_uuid(); fan uuid := gen_random_uuid(); fan2 uuid := gen_random_uuid(); bot uuid := gen_random_uuid();
  room uuid; room2 uuid; room3 uuid; r record; n int; t0 timestamptz; upd timestamptz;
begin
  insert into public.service_bot_accounts values (bot);

  -- 1. Creating a pending, future room gives the host one entry marked host.
  insert into public.community_live_streams (title, description, status, scheduled_for, duration_minutes, created_by)
    values ('Song release', 'Party', 'pending', now() + interval '2 days', 90, host) returning id into room;
  select * into r from public.calendar_events where user_id = host and source_ref_id = room::text;
  assert r.source_type = 'live_room' and r.source_ref_type = 'live_room' and r.status = 'confirmed', 'host entry: live_room shape, confirmed';
  assert (r.metadata->>'host')::boolean, 'host entry is marked host';
  assert r.end_time - r.start_time = interval '90 minutes', 'host entry ends after duration_minutes';

  -- 2. A subscriber gets a row; the host row is untouched.
  insert into public.live_stream_subscribers (stream_id, user_id) values (room, fan), (room, fan2);
  select count(*) into n from public.calendar_events where source_ref_id = room::text;
  assert n = 3, format('host + two fans (got %s)', n);

  -- 3. The host also taps Erinnern: still one host row, host flag survives.
  insert into public.live_stream_subscribers (stream_id, user_id) values (room, host);
  select count(*) into n from public.calendar_events where user_id = host and source_ref_id = room::text;
  assert n = 1, 'host who subscribes still has one row';
  assert (select (metadata->>'host')::boolean from public.calendar_events where user_id = host and source_ref_id = room::text), 'host flag survives the host''s own Erinnern';

  -- 4. Host un-notifies: the host row stays; a fan un-notifying is cancelled.
  delete from public.live_stream_subscribers where stream_id = room and user_id = host;
  assert (select status from public.calendar_events where user_id = host and source_ref_id = room::text) = 'confirmed', 'host entry survives the host''s un-notify';
  delete from public.live_stream_subscribers where stream_id = room and user_id = fan2;
  assert (select status from public.calendar_events where user_id = fan2 and source_ref_id = room::text) = 'cancelled', 'a fan''s un-notify still cancels';

  -- 5. Reschedule + rename + longer: every live entry moves; a cancelled one stays put.
  update public.community_live_streams set scheduled_for = now() + interval '5 days', title = 'Song release (moved)', duration_minutes = 120 where id = room;
  for r in select * from public.calendar_events where source_ref_id = room::text and status <> 'cancelled' loop
    assert r.title = 'Song release (moved)', 'title follows';
    assert r.start_time > now() + interval '4 days', 'start follows';
    assert r.end_time - r.start_time = interval '120 minutes', 'duration follows';
  end loop;
  assert (select start_time from public.calendar_events where user_id = fan2 and source_ref_id = room::text) < now() + interval '3 days', 'a cancelled entry is not moved';

  -- 6. The fan who un-notified re-notifies after the reschedule: revived at the NEW time.
  insert into public.live_stream_subscribers (stream_id, user_id) values (room, fan2);
  select * into r from public.calendar_events where user_id = fan2 and source_ref_id = room::text;
  assert r.status = 'confirmed' and r.start_time > now() + interval '4 days' and r.title = 'Song release (moved)', 're-notify revives at the current time';

  -- 7. An unrelated update (viewer_count) touches nothing.
  select max(updated_at) into t0 from public.calendar_events where source_ref_id = room::text;
  perform pg_sleep(0.05);
  update public.community_live_streams set viewer_count = 5 where id = room;
  select max(updated_at) into upd from public.calendar_events where source_ref_id = room::text;
  assert t0 = upd, 'a column the trigger does not watch changes nothing';

  -- 8. Status whitelist: live and ended leave the entries alone; cancelled cancels.
  update public.community_live_streams set status = 'live' where id = room;
  assert (select count(*) from public.calendar_events where source_ref_id = room::text and status = 'confirmed') = 3, 'status live: entries untouched';
  update public.community_live_streams set status = 'ended', title = 'Song release (ended)' where id = room;
  assert (select count(*) from public.calendar_events where source_ref_id = room::text and status = 'confirmed') = 3, 'status ended: entries untouched';
  assert (select title from public.calendar_events where user_id = host and source_ref_id = room::text) = 'Song release (moved)', 'a started/ended room''s entries are not re-titled';
  update public.community_live_streams set status = 'cancelled' where id = room;
  assert (select count(*) from public.calendar_events where source_ref_id = room::text and status <> 'cancelled') = 0, 'status cancelled: every entry cancelled';

  -- 9. Cancelled entries are not revived by a later edit.
  update public.community_live_streams set scheduled_for = now() + interval '9 days' where id = room;
  assert (select count(*) from public.calendar_events where source_ref_id = room::text and status <> 'cancelled') = 0, 'an edit never revives a cancelled entry';

  -- 10. No date any more -> cancelled.
  insert into public.community_live_streams (title, status, scheduled_for, created_by) values ('Dateless', 'pending', now() + interval '3 days', host) returning id into room2;
  insert into public.live_stream_subscribers (stream_id, user_id) values (room2, fan);
  update public.community_live_streams set scheduled_for = null where id = room2;
  assert (select count(*) from public.calendar_events where source_ref_id = room2::text and status <> 'cancelled') = 0, 'scheduled_for NULL cancels';

  -- 11. Delete the room -> every entry cancelled (subscribers cascade-delete).
  insert into public.community_live_streams (title, status, scheduled_for, created_by) values ('To delete', 'pending', now() + interval '3 days', host) returning id into room3;
  insert into public.live_stream_subscribers (stream_id, user_id) values (room3, fan);
  delete from public.community_live_streams where id = room3;
  assert (select count(*) from public.calendar_events where source_ref_id = room3::text and status <> 'cancelled') = 0, 'deleting a room cancels every entry';

  -- 12. Bot host / past room: no entry.
  insert into public.community_live_streams (title, status, scheduled_for, created_by) values ('Bot room', 'pending', now() + interval '3 days', bot);
  insert into public.community_live_streams (title, status, scheduled_for, created_by) values ('Past room', 'pending', now() - interval '1 day', host);
  assert (select count(*) from public.calendar_events where title in ('Bot room','Past room')) = 0, 'bot host and past room get no entry';
end $$;

\echo 'PASS vtid-04976 live room host calendar'
