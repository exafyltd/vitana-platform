-- BOOTSTRAP-AI-POLICIES-FIX: Corrected seed for ai_provider_policies.
--
-- The earlier seed migration (20260420140000) and the Phase 1 migration's
-- internal seed both referenced tenants.id — but this database's tenants
-- table uses tenant_id as the PK. psql runs without ON_ERROR_STOP by default,
-- so the INSERT errored silently while the wrapping workflow reported success.
--
-- This file uses t.tenant_id (the actual column) and is idempotent via
-- ON CONFLICT DO NOTHING.

\set ON_ERROR_STOP on

INSERT INTO public.ai_provider_policies (
  tenant_id,
  provider,
  allowed,
  allowed_models,
  cost_cap_usd_month
)
SELECT
  t.tenant_id,
  'chatgpt',
  TRUE,
  ARRAY[
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4-turbo',
    'o1-mini'
  ],
  50
FROM public.tenants t
ON CONFLICT (tenant_id, provider) DO NOTHING;

INSERT INTO public.ai_provider_policies (
  tenant_id,
  provider,
  allowed,
  allowed_models,
  cost_cap_usd_month
)
SELECT
  t.tenant_id,
  'claude',
  TRUE,
  ARRAY[
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022'
  ],
  50
FROM public.tenants t
ON CONFLICT (tenant_id, provider) DO NOTHING;

-- Confirm row counts so the RUN-MIGRATION log shows what landed.
do $$
declare
  tenants_n int;
  chatgpt_n int;
  claude_n int;
begin
  select count(*) into tenants_n from public.tenants;
  select count(*) into chatgpt_n from public.ai_provider_policies
    where provider = 'chatgpt' and allowed = true;
  select count(*) into claude_n from public.ai_provider_policies
    where provider = 'claude' and allowed = true;
  raise notice 'tenants=% chatgpt_allowed_rows=% claude_allowed_rows=%',
    tenants_n, chatgpt_n, claude_n;
end$$;
