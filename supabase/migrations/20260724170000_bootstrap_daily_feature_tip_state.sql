-- BOOTSTRAP-DAILY-FEATURE-TIP
--
-- Backs the automatic once-a-day "Did You Know" News Feed card
-- (services/gateway/src/routes/scheduled-notifications.ts POST
-- /daily-feature-tip, fed by services/gateway/src/data/feature-tips.ts).
-- One row per tenant tracks which tip in the curated rotation ran last, so
-- the daily cron can advance to the next one and wrap around once the list
-- is exhausted, without ever repeating a tip back-to-back.
--
-- Written and read only by the gateway's scheduled job (service role) —
-- never exposed to clients, so no client-facing RLS SELECT policy.

create table if not exists public.did_you_know_state (
  tenant_id uuid primary key,
  last_index integer not null default -1,
  updated_at timestamptz not null default now()
);

alter table public.did_you_know_state enable row level security;

drop policy if exists did_you_know_state_service_role_all on public.did_you_know_state;
create policy did_you_know_state_service_role_all
  on public.did_you_know_state
  for all
  to service_role
  using (true)
  with check (true);
