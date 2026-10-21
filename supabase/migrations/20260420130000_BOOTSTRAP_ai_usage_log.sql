-- BOOTSTRAP-ORB-DELEGATION-SCAFFOLD: ai_usage_log + monthly view
--
-- Companion to VTID-02403 Phase 1 (ai_assistant_credentials + ai_provider_policies).
-- That phase stored the cost cap but there was no counter against it. This
-- migration adds the counter so the delegation executor can enforce budgets
-- before calling an external AI on a user's behalf.
--
-- Columns mirror the DelegationResult + LogUsageInput types in
-- services/gateway/src/orb/delegation/{usage,types}.ts.

create table if not exists public.ai_usage_log (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),

  user_id               uuid not null,
  tenant_id             uuid,
  connection_id         uuid, -- fk logically to ai_assistant_credentials.connection_id; not enforced to keep insert path hot

  provider              text not null,
  model                 text,

  request_tokens        integer not null default 0,
  response_tokens       integer not null default 0,
  estimated_cost_usd    numeric(12,6) not null default 0,

  session_id            text,
  vtid                  text,

  latency_ms            integer,
  status                text not null check (status in ('ok','timeout','error','cap_exceeded','unauthorized')),

  metadata              jsonb not null default '{}'::jsonb
);

comment on table public.ai_usage_log is
  'BOOTSTRAP-ORB-DELEGATION-SCAFFOLD: Per-call log of external AI delegation (ChatGPT, Claude, Google AI). One row per delegation attempt, success or failure.';

-- Indexes sized for the two hot queries:
--   (a) per-user recent-activity dashboards
--   (b) per-tenant/per-provider monthly rollups (backs the materialized view)
create index if not exists ai_usage_log_user_time_idx
  on public.ai_usage_log (user_id, created_at desc);

create index if not exists ai_usage_log_tenant_provider_time_idx
  on public.ai_usage_log (tenant_id, provider, created_at desc);

create index if not exists ai_usage_log_user_provider_time_idx
  on public.ai_usage_log (user_id, provider, created_at desc);

-- RLS: users can read their own rows; tenant admins can read their tenant's rows.
-- Writes are via gateway service role; do not grant write to anon/authenticated.
alter table public.ai_usage_log enable row level security;

create policy ai_usage_log_self_read
  on public.ai_usage_log
  for select
  to authenticated
  using (user_id = auth.uid());

-- Monthly rollup view powering delegation/budget.ts. Fast path: never scans
-- ai_usage_log directly on the request path. Refresh is invoked by the
-- pg_cron job below (or can be run manually via: refresh materialized view ...).
create materialized view if not exists public.ai_usage_month_by_user_provider as
select
  user_id,
  tenant_id,
  provider,
  date_trunc('month', created_at) as month_start,
  count(*)                                         as call_count,
  sum(request_tokens)                              as total_input_tokens,
  sum(response_tokens)                             as total_output_tokens,
  sum(estimated_cost_usd)::numeric(12,6)           as total_cost_usd
from public.ai_usage_log
where created_at >= date_trunc('month', now())
group by user_id, tenant_id, provider, month_start;

create unique index if not exists ai_usage_month_by_user_provider_uniq_idx
  on public.ai_usage_month_by_user_provider (user_id, provider, month_start);

create index if not exists ai_usage_month_by_user_provider_tenant_idx
  on public.ai_usage_month_by_user_provider (tenant_id, provider, month_start);

-- Initial populate
refresh materialized view public.ai_usage_month_by_user_provider;

-- pg_cron refresh every 5 minutes. If pg_cron isn't installed this silently
-- does nothing; the view can still be manually refreshed.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'ai-usage-month-refresh',
      '*/5 * * * *',
      $$refresh materialized view concurrently public.ai_usage_month_by_user_provider;$$
    );
  end if;
exception
  when others then
    raise notice 'pg_cron scheduling skipped (likely not installed): %', sqlerrm;
end$$;
