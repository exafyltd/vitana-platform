-- VTID-04978: one-shot personal reminders are mirrored into the calendar, on a
-- throwaway local Postgres. Never run against a shared or production database.
-- Run: scripts/ci/sql-tests/run-reminders-in-calendar-test.sh
\set ON_ERROR_STOP on

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

create table public.service_bot_accounts (user_id uuid primary key);
create table public.notification_test_actors (user_id uuid primary key);
create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null, tenant_id uuid not null default gen_random_uuid(),
  action_text text not null, spoken_message text not null default 'x', description text,
  next_fire_at timestamptz not null, recurrence_rule text,
  status text not null default 'pending'
    check (status in ('pending','dispatching','fired','completed','failed','cancelled')),
  calendar_event_id uuid,
  created_via text not null check (created_via in ('voice','ui','system'))
);
create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null, title text, description text,
  start_time timestamptz, end_time timestamptz,
  event_type text, source_type text, source_ref_id text, source_ref_type text,
  status text default 'confirmed', role_context text, completion_status text,
  reminder_offsets integer[],
  metadata jsonb default '{}'::jsonb, updated_at timestamptz default now(),
  constraint valid_source_type check (source_type in ('manual','live_room'))
);
create unique index idx_calendar_events_source_ref
  on public.calendar_events (user_id, source_ref_id, source_ref_type) where source_ref_id is not null;

-- Before the migration: a pending future voice reminder, a recurring one, a past one, a bot's.
do $$
declare bot uuid := gen_random_uuid(); u uuid := gen_random_uuid();
begin
  insert into public.service_bot_accounts values (bot);
  insert into public.reminders (user_id, action_text, next_fire_at, created_via) values
    (u, 'Backfill me', now() + interval '2 days', 'voice'),
    (u, 'Backfill past', now() - interval '2 days', 'voice'),
    (bot, 'Backfill bot', now() + interval '2 days', 'ui');
  insert into public.reminders (user_id, action_text, next_fire_at, created_via, recurrence_rule) values
    (u, 'Backfill recurring', now() + interval '2 days', 'ui', 'FREQ=DAILY');
  insert into public.reminders (user_id, action_text, next_fire_at, created_via, calendar_event_id) values
    (u, 'Backfill system', now() + interval '2 days', 'system', gen_random_uuid());
end $$;

\ir ../../../supabase/migrations/20261008150000_vtid_04978_reminders_in_calendar.sql
\ir ../../../supabase/migrations/20261008150000_vtid_04978_reminders_in_calendar.sql

do $$
declare n int;
begin
  select count(*) into n from public.calendar_events where source_type = 'reminder';
  assert n = 1, format('backfill: only the pending future member reminder (got %s)', n);
  assert exists (select 1 from public.calendar_events where title = 'Backfill me' and reminder_offsets = '{}'), 'backfill row carries no extra reminder offsets';
end $$;

do $$
declare
  u uuid := gen_random_uuid(); bot uuid := gen_random_uuid();
  r1 uuid; r2 uuid; r3 uuid; r4 uuid; c record; n int; t0 timestamptz;
begin
  insert into public.service_bot_accounts values (bot);

  -- 1. Create: one mirror row with the right shape.
  insert into public.reminders (user_id, action_text, description, next_fire_at, created_via)
    values (u, 'Call mum', 'about Sunday', now() + interval '1 day', 'voice') returning id into r1;
  select * into c from public.calendar_events where user_id = u and source_ref_id = r1::text;
  assert c.source_type = 'reminder' and c.source_ref_type = 'reminder' and c.event_type = 'personal'
     and c.status = 'confirmed' and c.role_context = 'personal', 'mirror row shape';
  assert c.title = 'Call mum' and c.description = 'about Sunday', 'title and description';
  assert c.reminder_offsets = '{}', 'no second reminder from the calendar';
  assert c.start_time = (select next_fire_at from public.reminders where id = r1), 'starts at the fire time';

  -- 2. Snooze: pending again at a later time moves the row.
  update public.reminders set status = 'fired' where id = r1;
  select * into c from public.calendar_events where source_ref_id = r1::text;
  assert c.status = 'confirmed', 'fired: the row stays';
  t0 := now() + interval '3 hours';
  update public.reminders set status = 'pending', next_fire_at = t0 where id = r1;
  select * into c from public.calendar_events where source_ref_id = r1::text;
  assert c.start_time = t0 and c.status = 'confirmed', 'snooze moves the row';
  select count(*) into n from public.calendar_events where source_ref_id = r1::text;
  assert n = 1, 'still one row';

  -- 3. Completed marks the row, does not cancel it.
  update public.reminders set status = 'completed' where id = r1;
  select * into c from public.calendar_events where source_ref_id = r1::text;
  assert c.completion_status = 'completed' and c.status = 'confirmed', 'completed keeps the row, marks it done';

  -- 4. Cancelled cancels; a later snooze-back to pending revives and clears completion.
  insert into public.reminders (user_id, action_text, next_fire_at, created_via)
    values (u, 'Water plants', now() + interval '5 hours', 'ui') returning id into r2;
  update public.reminders set status = 'cancelled' where id = r2;
  select * into c from public.calendar_events where source_ref_id = r2::text;
  assert c.status = 'cancelled', 'cancelled reminder cancels the row';
  update public.reminders set status = 'pending', next_fire_at = now() + interval '6 hours', action_text = 'Water the plants' where id = r2;
  select * into c from public.calendar_events where source_ref_id = r2::text;
  assert c.status = 'confirmed' and c.title = 'Water the plants', 'revived with the new text';

  -- 5. Failed cancels. Delete cancels.
  insert into public.reminders (user_id, action_text, next_fire_at, created_via)
    values (u, 'Fails', now() + interval '7 hours', 'voice') returning id into r3;
  update public.reminders set status = 'failed' where id = r3;
  assert (select status from public.calendar_events where source_ref_id = r3::text) = 'cancelled', 'failed cancels';
  delete from public.reminders where id = r2;
  assert (select status from public.calendar_events where source_ref_id = r2::text) = 'cancelled', 'delete cancels';

  -- 6. Out of scope: recurring, system/calendar-linked, bot.
  insert into public.reminders (user_id, action_text, next_fire_at, created_via, recurrence_rule)
    values (u, 'Recurring', now() + interval '1 day', 'ui', 'FREQ=DAILY');
  insert into public.reminders (user_id, action_text, next_fire_at, created_via, calendar_event_id)
    values (u, 'Linked', now() + interval '1 day', 'system', gen_random_uuid());
  insert into public.reminders (user_id, action_text, next_fire_at, created_via, calendar_event_id)
    values (u, 'Ui but linked', now() + interval '1 day', 'ui', gen_random_uuid());
  insert into public.reminders (user_id, action_text, next_fire_at, created_via)
    values (bot, 'Bot', now() + interval '1 day', 'ui');
  select count(*) into n from public.calendar_events where title in ('Recurring','Linked','Ui but linked','Bot');
  assert n = 0, format('recurring / linked / bot reminders are not mirrored (got %s)', n);

  -- 7. Editing only an unrelated column writes nothing new.
  select updated_at into t0 from public.calendar_events where source_ref_id = r1::text;
  update public.reminders set spoken_message = 'changed' where id = r1;
  assert (select updated_at from public.calendar_events where source_ref_id = r1::text) = t0, 'unrelated column: no calendar write';

  -- 8. A client with no reminder row (calendar_event_id set later) is left alone.
  insert into public.reminders (user_id, action_text, next_fire_at, created_via)
    values (u, 'Later linked', now() + interval '1 day', 'ui') returning id into r4;
  update public.reminders set calendar_event_id = gen_random_uuid(), status = 'cancelled' where id = r4;
  assert (select status from public.calendar_events where source_ref_id = r4::text) = 'confirmed', 'once linked to a calendar entry the reminder no longer drives the mirror';
end $$;

select 'PASS vtid-04978 reminders in calendar';
