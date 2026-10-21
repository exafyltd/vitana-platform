-- VTID-04997: the expected date of a health test result is mirrored into the
-- calendar, on a throwaway local Postgres. Never run against a shared or
-- production database.
-- Run: scripts/ci/sql-tests/run-test-results-in-calendar-test.sh
\set ON_ERROR_STOP on

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

create table public.service_bot_accounts (user_id uuid primary key);
create table public.notification_test_actors (user_id uuid primary key);
create table public.partner_health_test_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  test_name text not null,
  status text not null default 'ordered' check (status in ('ordered','sample_kit_shipped','sample_received','processing','result_ready','delivered','cancelled','failed','quarantined')),
  external_order_ref text,
  expected_result_at timestamptz
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

-- Before the migration: existing orders.
do $$
declare bot uuid := gen_random_uuid();
begin
  insert into public.service_bot_accounts values (bot);
  insert into public.partner_health_test_orders (user_id, test_name, status, expected_result_at) values (gen_random_uuid(), 'Vitamin D panel', 'processing', now() + interval '6 days');   -- mirrored
  insert into public.partner_health_test_orders (user_id, test_name, status, expected_result_at) values (gen_random_uuid(), 'Past test', 'ordered', now() - interval '1 day');            -- past
  insert into public.partner_health_test_orders (user_id, test_name, status, expected_result_at) values (gen_random_uuid(), 'No date test', 'ordered', NULL);                           -- no date
  insert into public.partner_health_test_orders (user_id, test_name, status, expected_result_at) values (gen_random_uuid(), 'Cancelled test', 'cancelled', now() + interval '5 days');     -- cancelled
  insert into public.partner_health_test_orders (user_id, test_name, status, expected_result_at) values (gen_random_uuid(), 'Ready test', 'result_ready', now() + interval '5 days');      -- result ready
  insert into public.partner_health_test_orders (user_id, test_name, status, expected_result_at) values (bot, 'Bot test', 'ordered', now() + interval '5 days');                         -- bot
end $$;

\ir ../../../supabase/migrations/20261010100000_vtid_04997_test_results_in_calendar.sql
\ir ../../../supabase/migrations/20261010100000_vtid_04997_test_results_in_calendar.sql

do $$
declare n int;
begin
  select count(*) into n from public.calendar_events where source_type = 'test_result';
  assert n = 1, format('backfill: only the future pending order is mirrored (got %s)', n);
  assert exists (select 1 from public.calendar_events where title = 'Vitamin D panel' and event_type = 'health' and role_context = 'personal' and status = 'confirmed'), 'backfill: shape';
  assert not exists (select 1 from public.calendar_events where reminder_offsets is distinct from '{}'), 'no reminders from these entries';
end $$;

do $$
declare
  u uuid := gen_random_uuid(); bot uuid := gen_random_uuid();
  oid uuid; c record; n int; t0 timestamptz; d1 timestamptz := now() + interval '10 days';
begin
  insert into public.service_bot_accounts values (bot);

  -- 1. A new order: one entry at the expected date, titled with the test name only.
  insert into public.partner_health_test_orders (user_id, test_name, status, expected_result_at, external_order_ref)
    values (u, 'Gut microbiome', 'ordered', d1, 'PARTNER-SECRET-REF') returning id into oid;
  select * into c from public.calendar_events where user_id = u and source_ref_id = oid::text and source_ref_type = 'test_result_expected';
  assert c.source_type = 'test_result' and c.event_type = 'health' and c.role_context = 'personal' and c.status = 'confirmed', 'entry shape';
  assert c.title = 'Gut microbiome', 'title is the test name only';
  assert c.start_time = d1 and c.end_time = d1 + interval '15 minutes', '15-minute span at the expected date';
  assert c.reminder_offsets = '{}'::int[], 'no reminders';
  assert c.metadata = jsonb_build_object('kind', 'test_result_expected', 'order_id', oid::text), 'metadata holds only kind and order id';
  assert position('PARTNER-SECRET-REF' in (to_jsonb(c))::text) = 0 and position('ordered' in c.title) = 0, 'nothing from partner data or status in the row';

  -- 2. The expected date moves.
  update public.partner_health_test_orders set expected_result_at = d1 + interval '3 days', status = 'processing' where id = oid;
  select count(*) into n from public.calendar_events where user_id = u; assert n = 1, 'still one row';
  select * into c from public.calendar_events where user_id = u;
  assert c.start_time = d1 + interval '3 days' and c.status = 'confirmed' and c.title = 'Gut microbiome', 'date moved';

  -- 3. Renamed test: the title follows the name.
  update public.partner_health_test_orders set test_name = 'Gut microbiome plus' where id = oid;
  assert (select title from public.calendar_events where user_id = u) = 'Gut microbiome plus', 'rename follows';

  -- 4. Result ready cancels; back to pending revives.
  update public.partner_health_test_orders set status = 'result_ready' where id = oid;
  assert (select status from public.calendar_events where user_id = u) = 'cancelled', 'result_ready -> entry cancelled';
  update public.partner_health_test_orders set status = 'processing' where id = oid;
  assert (select status from public.calendar_events where user_id = u) = 'confirmed', 'pending again -> revived';

  -- 5. Every other terminal status cancels.
  update public.partner_health_test_orders set status = 'failed' where id = oid;
  assert (select status from public.calendar_events where user_id = u) = 'cancelled', 'failed -> cancelled';
  update public.partner_health_test_orders set status = 'sample_received' where id = oid;
  update public.partner_health_test_orders set status = 'quarantined' where id = oid;
  assert (select status from public.calendar_events where user_id = u) = 'cancelled', 'quarantined -> cancelled';
  update public.partner_health_test_orders set status = 'sample_kit_shipped' where id = oid;
  update public.partner_health_test_orders set status = 'cancelled' where id = oid;
  assert (select status from public.calendar_events where user_id = u) = 'cancelled', 'cancelled -> cancelled';
  update public.partner_health_test_orders set status = 'sample_received' where id = oid;
  update public.partner_health_test_orders set status = 'delivered' where id = oid;
  assert (select status from public.calendar_events where user_id = u) = 'cancelled', 'delivered -> cancelled';
  update public.partner_health_test_orders set status = 'ordered' where id = oid;
  assert (select status from public.calendar_events where user_id = u) = 'confirmed', 'ordered again -> revived';

  -- 6. Date cleared or in the past cancels.
  update public.partner_health_test_orders set expected_result_at = NULL where id = oid;
  assert (select status from public.calendar_events where user_id = u) = 'cancelled', 'date cleared -> cancelled';
  update public.partner_health_test_orders set expected_result_at = now() - interval '1 hour' where id = oid;
  assert (select status from public.calendar_events where user_id = u) = 'cancelled', 'past date -> stays cancelled';
  update public.partner_health_test_orders set expected_result_at = d1 where id = oid;
  assert (select status from public.calendar_events where user_id = u) = 'confirmed', 'new future date -> revived';

  -- 7. An unwatched column writes nothing.
  select updated_at into t0 from public.calendar_events where user_id = u;
  update public.partner_health_test_orders set external_order_ref = 'other' where id = oid;
  assert (select updated_at from public.calendar_events where user_id = u) = t0, 'unwatched column: no calendar write';

  -- 8. Past date, no date, other terminal states and bot accounts get nothing on insert.
  insert into public.partner_health_test_orders (user_id, test_name, status, expected_result_at) values (gen_random_uuid(), 'Past', 'ordered', now() - interval '2 days');
  insert into public.partner_health_test_orders (user_id, test_name, status, expected_result_at) values (gen_random_uuid(), 'No date', 'ordered', NULL);
  insert into public.partner_health_test_orders (user_id, test_name, status, expected_result_at) values (gen_random_uuid(), 'Cancelled', 'cancelled', now() + interval '2 days');
  insert into public.partner_health_test_orders (user_id, test_name, status, expected_result_at) values (bot, 'Bot', 'ordered', now() + interval '9 days');
  select count(*) into n from public.calendar_events where user_id = bot; assert n = 0, 'bot: nothing';
  select count(*) into n from public.calendar_events where source_type = 'test_result' and status = 'confirmed'; assert n = 2, format('only the two real future entries (backfill + step 1) are confirmed (got %s)', n);
  select count(*) into n from public.calendar_events where start_time < now() and source_type = 'test_result' and status = 'confirmed'; assert n = 0, 'no entry in the past';

  -- 9. Own rows only: the entry belongs to the order's user.
  assert (select count(*) from public.calendar_events where source_ref_id = oid::text and user_id <> u) = 0, 'entry belongs to the order user only';

  -- 10. Delete cancels.
  delete from public.partner_health_test_orders where id = oid;
  assert (select status from public.calendar_events where user_id = u) = 'cancelled', 'delete cancels';

  -- 11. A failing calendar write never blocks the order write.
  insert into public.partner_health_test_orders (user_id, test_name, status, expected_result_at) values (u, 'Boom test', 'ordered', d1) returning id into oid;
  alter table public.calendar_events add constraint boom check (title <> 'Boom renamed') not valid;
  update public.partner_health_test_orders set test_name = 'Boom renamed' where id = oid;   -- would write that title -> constraint fails inside the trigger
  assert (select test_name from public.partner_health_test_orders where id = oid) = 'Boom renamed', 'order write went through despite the failing mirror';
  alter table public.calendar_events drop constraint boom;
end $$;

\echo PASS vtid-04997 test results in calendar
