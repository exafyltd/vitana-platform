-- BOOTSTRAP-AI-POLICIES: Seed default ai_provider_policies for every tenant.
--
-- Problem this fixes:
--   Users connecting a Claude / ChatGPT API key via
--   /settings/connected-apps hit PROVIDER_NOT_ALLOWED_FOR_TENANT
--   (routes/ai-assistants.ts:319). That check fails when there is no row in
--   ai_provider_policies for (tenant_id, provider) with allowed=true.
--
--   The VTID-02403 Phase 1 migration seeded Maxina via a slug='maxina' match,
--   which silently fails on any deployment where the canonical tenant slug
--   isn't exactly 'maxina'. It also doesn't cover any other tenant.
--
--   This migration seeds TRUE-by-default rows for every existing tenant, for
--   both providers, idempotently via ON CONFLICT DO NOTHING. Any tenant that
--   needs to deny a provider can flip allowed=false via the admin drawer.
--
-- Safety notes:
--   - ON CONFLICT DO NOTHING means this never overrides a tenant's existing
--     allowed=false explicit deny.
--   - The cost_cap_usd_month default of 50 applies only to new rows; existing
--     rows keep whatever cap the admin set.
--   - Uses the broader Claude model list so the delegation layer (shipped in
--     #757) can pick claude-opus-4-7 / claude-sonnet-4-6 when the user wants
--     the newest models, while keeping 3.5 in the list for backwards compat.

INSERT INTO public.ai_provider_policies (
  tenant_id,
  provider,
  allowed,
  allowed_models,
  cost_cap_usd_month
)
SELECT
  t.id,
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
  t.id,
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
