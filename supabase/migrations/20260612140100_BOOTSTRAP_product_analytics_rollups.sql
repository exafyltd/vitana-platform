-- BOOTSTRAP-PRODUCT-ANALYTICS: daily rollups for product analytics.
--
-- The gateway rollup job aggregates the prior day's raw
-- product_analytics_events into one row per (tenant, date, metric,
-- dimensions). Dashboards read long-window trends from here so the raw
-- table can be purged at 180 days while rollups are kept for 2 years.

create table if not exists public.product_analytics_daily_rollups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  rollup_date date not null,
  metric_key text not null,
  dimensions jsonb not null default '{}'::jsonb,
  metric_value numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, rollup_date, metric_key, dimensions)
);

create index if not exists product_analytics_daily_rollups_lookup_idx
  on public.product_analytics_daily_rollups (tenant_id, rollup_date desc, metric_key);

create index if not exists product_analytics_daily_rollups_dimensions_gin_idx
  on public.product_analytics_daily_rollups using gin (dimensions);

alter table public.product_analytics_daily_rollups enable row level security;

create policy "service role can manage product analytics rollups"
  on public.product_analytics_daily_rollups
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
