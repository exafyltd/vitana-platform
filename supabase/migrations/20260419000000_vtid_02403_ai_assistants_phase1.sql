-- Migration: 20260419000000_vtid_02403_ai_assistants_phase1.sql
-- VTID: VTID-02403 — AI Subscription Connect Phase 1
-- Purpose: Introduce the "ai_assistant" connector category (ChatGPT, Claude),
--          per-tenant AI policy table, encrypted credential vault and consent log.
--
-- Scope (Phase 1):
--   * API-key paste + verify ONLY (no OAuth, no MCP bridges, no cost metrics, no kill-switch).
--   * Providers: chatgpt (OpenAI) + claude (Anthropic).
--   * Tenant gating: Maxina is seeded allowed; others default allowed=false via absence.

-- =============================================================================
-- 0. EXTENSIONS
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- 1. connector_registry — extend category CHECK to include 'ai_assistant'
-- =============================================================================
-- The original 20260417000000 migration added a CHECK constraint that listed
-- the concrete set of categories. We need to extend it to include
-- 'ai_assistant' so the two rows we seed below pass the constraint.

DO $$
DECLARE
  c_name TEXT;
BEGIN
  SELECT conname INTO c_name
  FROM pg_constraint
  WHERE conrelid = 'public.connector_registry'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%category%';
  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.connector_registry DROP CONSTRAINT %I', c_name);
  END IF;
END$$;

ALTER TABLE public.connector_registry
  ADD CONSTRAINT connector_registry_category_check
  CHECK (category IN ('social','wearable','shop','calendar','productivity','aggregator','ai_assistant'));

-- =============================================================================
-- 2. connector_registry — seed chatgpt + claude
-- =============================================================================

INSERT INTO public.connector_registry (
  id, category, display_name, description, auth_type,
  capabilities, default_scopes, underlying_providers,
  enabled, requires_ios_companion, docs_url
) VALUES
  ('chatgpt', 'ai_assistant', 'ChatGPT',
   'OpenAI ChatGPT via user-supplied API key. Enables your personal AI assistant for chat, reasoning and drafting.',
   'api_key',
   ARRAY['chat','reasoning'],
   ARRAY[]::TEXT[],
   NULL,
   TRUE, FALSE,
   'https://platform.openai.com/api-keys'),
  ('claude', 'ai_assistant', 'Claude',
   'Anthropic Claude via user-supplied API key. Enables your personal AI assistant for chat, reasoning and long-context work.',
   'api_key',
   ARRAY['chat','reasoning'],
   ARRAY[]::TEXT[],
   NULL,
   TRUE, FALSE,
   'https://console.anthropic.com/settings/keys')
ON CONFLICT (id) DO UPDATE
  SET category = EXCLUDED.category,
      display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      auth_type = EXCLUDED.auth_type,
      capabilities = EXCLUDED.capabilities,
      docs_url = EXCLUDED.docs_url,
      enabled = EXCLUDED.enabled,
      requires_ios_companion = EXCLUDED.requires_ios_companion,
      updated_at = NOW();

-- =============================================================================
-- 3. ai_provider_policies — per-tenant × provider policy
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.ai_provider_policies (
  tenant_id UUID NOT NULL,
  provider TEXT NOT NULL,
  allowed BOOLEAN NOT NULL DEFAULT TRUE,
  allowed_models TEXT[] NOT NULL DEFAULT '{}',
  cost_cap_usd_month NUMERIC(10,2) NOT NULL DEFAULT 50,
  allowed_memory_categories TEXT[] NOT NULL DEFAULT '{}',
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_ai_provider_policies_tenant
  ON public.ai_provider_policies (tenant_id);

ALTER TABLE public.ai_provider_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_provider_policies_select_tenant ON public.ai_provider_policies;
CREATE POLICY ai_provider_policies_select_tenant ON public.ai_provider_policies
  FOR SELECT TO authenticated
  USING (
    tenant_id IN (
      SELECT ut.tenant_id FROM public.user_tenants ut
      WHERE ut.user_id = auth.uid() AND ut.is_active = TRUE
    )
  );

DROP POLICY IF EXISTS ai_provider_policies_service ON public.ai_provider_policies;
CREATE POLICY ai_provider_policies_service ON public.ai_provider_policies
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

GRANT SELECT ON public.ai_provider_policies TO authenticated;

-- Seed Maxina tenant
INSERT INTO public.ai_provider_policies (tenant_id, provider, allowed, allowed_models, cost_cap_usd_month)
SELECT t.id, 'chatgpt', TRUE,
       ARRAY['gpt-4o','gpt-4o-mini','gpt-4-turbo'],
       50
FROM public.tenants t
WHERE t.slug = 'maxina'
ON CONFLICT (tenant_id, provider) DO NOTHING;

INSERT INTO public.ai_provider_policies (tenant_id, provider, allowed, allowed_models, cost_cap_usd_month)
SELECT t.id, 'claude', TRUE,
       ARRAY['claude-3-5-sonnet-20241022','claude-3-5-haiku-20241022','claude-3-opus-20240229'],
       50
FROM public.tenants t
WHERE t.slug = 'maxina'
ON CONFLICT (tenant_id, provider) DO NOTHING;

-- =============================================================================
-- 4. ai_assistant_credentials — encrypted API keys (AES-256-GCM at gateway layer)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.ai_assistant_credentials (
  connection_id UUID PRIMARY KEY REFERENCES public.user_connections(id) ON DELETE CASCADE,
  encrypted_key BYTEA NOT NULL,
  key_prefix TEXT NOT NULL,
  key_last4 TEXT NOT NULL,
  encryption_iv BYTEA NOT NULL,
  encryption_tag BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at TIMESTAMPTZ,
  last_verify_status TEXT,                   -- ok | unauthorized | network | error
  last_verify_error TEXT,
  verify_failure_count INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ai_assistant_credentials_verified
  ON public.ai_assistant_credentials (last_verified_at DESC);

ALTER TABLE public.ai_assistant_credentials ENABLE ROW LEVEL SECURITY;

-- Users can SELECT only the (non-secret) metadata of their OWN credentials
-- via a join to user_connections. We still rely on the route layer to NEVER
-- return encrypted_key over the wire.
DROP POLICY IF EXISTS ai_assistant_credentials_select_own ON public.ai_assistant_credentials;
CREATE POLICY ai_assistant_credentials_select_own ON public.ai_assistant_credentials
  FOR SELECT TO authenticated
  USING (
    connection_id IN (
      SELECT uc.id FROM public.user_connections uc WHERE uc.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS ai_assistant_credentials_service ON public.ai_assistant_credentials;
CREATE POLICY ai_assistant_credentials_service ON public.ai_assistant_credentials
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- No INSERT/UPDATE for authenticated — goes through service role on backend.
GRANT SELECT ON public.ai_assistant_credentials TO authenticated;

-- =============================================================================
-- 5. ai_consent_log — append-only audit of connect/disconnect/policy actions
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.ai_consent_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID,
  tenant_id UUID,
  provider TEXT,
  action TEXT NOT NULL,       -- 'connect' | 'disconnect' | 'verify_ok' | 'verify_failed' | 'policy_update'
  before_jsonb JSONB,
  after_jsonb JSONB,
  actor_role TEXT,            -- 'user' | 'operator' | 'service'
  actor_id UUID,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_consent_log_user_ts
  ON public.ai_consent_log (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_ai_consent_log_tenant_ts
  ON public.ai_consent_log (tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_ai_consent_log_provider
  ON public.ai_consent_log (provider, ts DESC);

ALTER TABLE public.ai_consent_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_consent_log_select_self ON public.ai_consent_log;
CREATE POLICY ai_consent_log_select_self ON public.ai_consent_log
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS ai_consent_log_service ON public.ai_consent_log;
CREATE POLICY ai_consent_log_service ON public.ai_consent_log
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

GRANT SELECT ON public.ai_consent_log TO authenticated;

-- =============================================================================
-- 6. COMMENTS
-- =============================================================================

COMMENT ON TABLE public.ai_provider_policies IS 'VTID-02403: Per-tenant × provider AI policy (allowed, models, cost cap, memory categories).';
COMMENT ON TABLE public.ai_assistant_credentials IS 'VTID-02403: Encrypted AI API keys (AES-256-GCM via gateway). NEVER expose encrypted_key in API responses.';
COMMENT ON TABLE public.ai_consent_log IS 'VTID-02403: Append-only audit of AI connect/disconnect/verify/policy events.';
