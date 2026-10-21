-- BOOTSTRAP-PRODUCT-ANALYTICS: raw product analytics event store.
--
-- Dedicated pipeline for product/behavior analytics (Assistant usage, click
-- journeys, feature adoption, interests, friction). Deliberately separate
-- from oasis_events: OASIS stays an audit/system-activity log, this table
-- absorbs high-volume clickstream without polluting governance queries.
--
-- Privacy invariants (enforced at the gateway ingestion layer too):
--   * user_id_hash only — never raw user ids, never emails.
--   * properties carry metadata (lengths, latencies, intents, topics) —
--     never raw Assistant message text, prompts, or transcripts.
--   * consent_state='denied' events are dropped before insert.
-- Retention: raw events are purged after 180 days by the gateway rollup job
-- (see services/gateway/src/services/product-analytics/rollup.ts).

create extension if not exists pgcrypto;

create table if not exists public.product_analytics_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  event_name text not null,
  event_type text not null check (
    event_type in (
      'journey',
      'assistant',
      'feature',
      'interest',
      'friction',
      'performance',
      'content'
    )
  ),
  tenant_id uuid not null,
  user_id_hash text,
  session_id text not null,
  journey_id text,
  conversation_id text,
  screen_route text not null,
  screen_id text,
  feature_key text,
  source text not null check (
    source in ('web', 'ios', 'android', 'gateway', 'assistant', 'orb')
  ),
  app_version text,
  language text,
  device_type text not null default 'unknown' check (
    device_type in ('desktop', 'mobile', 'tablet', 'unknown')
  ),
  consent_state text not null default 'anonymous' check (
    consent_state in ('granted', 'anonymous', 'denied')
  ),
  properties jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists product_analytics_events_tenant_time_idx
  on public.product_analytics_events (tenant_id, occurred_at desc);

create index if not exists product_analytics_events_name_time_idx
  on public.product_analytics_events (tenant_id, event_name, occurred_at desc);

create index if not exists product_analytics_events_conversation_idx
  on public.product_analytics_events (tenant_id, conversation_id, occurred_at desc)
  where conversation_id is not null;

create index if not exists product_analytics_events_session_idx
  on public.product_analytics_events (tenant_id, session_id, occurred_at desc);

create index if not exists product_analytics_events_route_idx
  on public.product_analytics_events (tenant_id, screen_route, occurred_at desc);

create index if not exists product_analytics_events_properties_gin_idx
  on public.product_analytics_events using gin (properties);

-- Retention purge scans on received_at.
create index if not exists product_analytics_events_received_idx
  on public.product_analytics_events (received_at);

alter table public.product_analytics_events enable row level security;

-- Only the gateway (service role) reads/writes; tenant scoping is enforced
-- by the gateway admin endpoints, never by handing clients direct access.
create policy "service role can manage product analytics events"
  on public.product_analytics_events
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
