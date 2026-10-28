-- VTID-04994: subscription renewal / trial end / Premium end dates are mirrored
-- into the calendar, on a throwaway local Postgres. Never run against a shared
-- or production database.
-- Run: scripts/ci/sql-tests/run-subscription-dates-in-calendar-test.sh
\set ON_ERROR_STOP on

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

create table public.service_bot_accounts (user_id uuid primary key);
create table public.notification_test_actors (user_id uuid primary key);
create table public.user_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  plan_key text not null default 'premium',
  status text not null check (status in ('trialing','active','past_due','unpaid','canceled','incomplete','incomplete_expired','paused','free')),
  stripe_customer_id text,
  stripe_subscription_id text unique,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  trial_end timestamptz,
  unique (tenant_id, user_id)
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

-- Before the migration: existing subscriptions.
do $$
declare u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); u3 uuid := gen_random_uuid(); u4 uuid := gen_random_uuid(); bot uuid := gen_random_uuid();
begin
  insert into public.service_bot_accounts values (bot);
  insert into public.user_subscriptions (user_id, status, stripe_subscription_id, current_period_end) values (u1, 'active', 'sub_bf1', now() + interval '20 days');
  insert into public.user_subscriptions (user_id, status, current_period_end) values (u2, 'active', now() + interval '300 days');      -- grant
  insert into public.user_subscriptions (user_id, status, stripe_subscription_id, current_period_end) values (u3, 'canceled', 'sub_bf3', now() + interval '5 days');
  insert into public.user_subscriptions (user_id, status, stripe_subscription_id, current_period_end, trial_end) values (u4, 'trialing', 'sub_bf4', now() + interval '10 days', now() + interval '7 days');
  insert into public.user_subscriptions (user_id, status, current_period_end) values (bot, 'active', now() + interval '10 days');
  insert into public.user_subscriptions (user_id, status, stripe_subscription_id, current_period_end) values (gen_random_uuid(), 'active', 'sub_bf5', now() - interval '1 day');
end $$;

\ir ../../../supabase/migrations/20261009090000_vtid_04994_subscription_dates_in_calendar.sql
\ir ../../../supabase/migrations/20261009090000_vtid_04994_subscription_dates_in_calendar.sql

do $$
declare n int;
begin
  select count(*) into n from public.calendar_events where source_type = 'subscription';
  assert n = 4, format('backfill: stripe-active + grant + trialing period + trial entry = 4 (got %s)', n);
  assert exists (select 1 from public.calendar_events where metadata->>'kind' = 'renews' and title = 'Premium renews'), 'backfill: renews';
  assert exists (select 1 from public.calendar_events where metadata->>'kind' = 'ends' and title = 'Premium ends'), 'backfill: grant ends';
  assert exists (select 1 from public.calendar_events where metadata->>'kind' = 'trial_ends'), 'backfill: trial ends';
  assert not exists (select 1 from public.calendar_events where reminder_offsets is distinct from '{}'), 'no reminders from these entries';
end $$;

do $$
declare
  u uuid := gen_random_uuid(); g uuid := gen_random_uuid(); bot uuid := gen_random_uuid(); t uuid := gen_random_uuid();
  sid uuid; gid uuid; tid uuid; c record; n int; t0 timestamptz; d1 timestamptz := now() + interval '30 days';
begin
  insert into public.service_bot_accounts values (bot);

  -- 1. A new Stripe subscription: one 'renews' entry at the period end.
  insert into public.user_subscriptions (user_id, status, stripe_subscription_id, current_period_end) values (u, 'active', 'sub_t1', d1) returning id into sid;
  select * into c from public.calendar_events where user_id = u and source_ref_id = sid::text and source_ref_type = 'subscription_period_end';
  assert c.source_type = 'subscription' and c.event_type = 'personal' and c.status = 'confirmed' and c.title = 'Premium renews', 'renews entry shape';
  assert c.start_time = d1 and c.metadata->>'kind' = 'renews', 'starts at the period end';

  -- 2. Set to cancel at period end: same row now says it ends.
  update public.user_subscriptions set cancel_at_period_end = true where id = sid;
  select count(*) into n from public.calendar_events where user_id = u; assert n = 1, 'still one row';
  select * into c from public.calendar_events where user_id = u;
  assert c.title = 'Premium ends' and c.metadata->>'kind' = 'ends', 'cancel at period end -> ends';

  -- 3. Period moves.
  update public.user_subscriptions set current_period_end = d1 + interval '30 days', cancel_at_period_end = false where id = sid;
  select * into c from public.calendar_events where user_id = u;
  assert c.start_time = d1 + interval '30 days' and c.title = 'Premium renews', 'renewal moved and back to renews';

  -- 4. Stops being active: entry cancelled; active again: revived.
  update public.user_subscriptions set status = 'canceled' where id = sid;
  assert (select status from public.calendar_events where user_id = u) = 'cancelled', 'canceled -> entry cancelled';
  update public.user_subscriptions set status = 'active' where id = sid;
  assert (select status from public.calendar_events where user_id = u) = 'confirmed', 'active again -> revived';

  -- 5. Unwatched column writes nothing.
  select updated_at into t0 from public.calendar_events where user_id = u;
  update public.user_subscriptions set stripe_customer_id = 'cus_x' where id = sid;
  assert (select updated_at from public.calendar_events where user_id = u) = t0, 'unwatched column: no calendar write';

  -- 6. A grant (no Stripe id) says it ends.
  insert into public.user_subscriptions (user_id, status, current_period_end) values (g, 'active', now() + interval '365 days') returning id into gid;
  assert (select metadata->>'kind' from public.calendar_events where user_id = g) = 'ends', 'grant -> ends';

  -- 7. Trial: period entry + trial entry; trial entry goes when no longer trialing.
  insert into public.user_subscriptions (user_id, status, stripe_subscription_id, current_period_end, trial_end)
    values (t, 'trialing', 'sub_t7', now() + interval '14 days', now() + interval '7 days') returning id into tid;
  select count(*) into n from public.calendar_events where user_id = t; assert n = 2, format('period + trial (got %s)', n);
  update public.user_subscriptions set status = 'active' where id = tid;
  assert (select status from public.calendar_events where user_id = t and source_ref_type = 'subscription_trial_end') = 'cancelled', 'trial entry cancelled when no longer trialing';
  assert (select status from public.calendar_events where user_id = t and source_ref_type = 'subscription_period_end') = 'confirmed', 'period entry stays';

  -- 8. Past end date and bot accounts get nothing.
  insert into public.user_subscriptions (user_id, status, stripe_subscription_id, current_period_end) values (gen_random_uuid(), 'active', 'sub_t8', now() - interval '2 days');
  insert into public.user_subscriptions (user_id, status, current_period_end) values (bot, 'active', now() + interval '9 days');
  select count(*) into n from public.calendar_events where user_id = bot; assert n = 0, 'bot: nothing';
  select count(*) into n from public.calendar_events where start_time < now() and source_type = 'subscription' and status = 'confirmed'; assert n = 0, 'no entry in the past';

  -- 9. Delete cancels.
  delete from public.user_subscriptions where id = gid;
  assert (select status from public.calendar_events where user_id = g) = 'cancelled', 'delete cancels';

  -- 10. A failing calendar write never blocks the billing write.
  alter table public.calendar_events add constraint boom check (title <> 'Premium ends') not valid;
  update public.user_subscriptions set cancel_at_period_end = true where id = sid;   -- would write 'Premium ends' -> constraint fails inside the trigger
  assert (select cancel_at_period_end from public.user_subscriptions where id = sid), 'billing write went through despite the failing mirror';
  alter table public.calendar_events drop constraint boom;
end $$;

\echo PASS vtid-04994 subscription dates in calendar
