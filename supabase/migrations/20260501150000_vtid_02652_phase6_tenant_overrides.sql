-- VTID-02652: Phase 6 — tenant override layer for the agent persona system.
--
-- Adds the data model that lets each tenant CUSTOMIZE the platform-built
-- specialists (built once in Command Hub) without forking platform records.
-- Three new tables for tenant-scoped overlays + one ALTER on the existing
-- third-party connections table to make those tenant-aware. Plus a
-- tenant-aware variant of pick_specialist_for_text that UNIONs platform
-- handoff_keywords with the tenant's own keywords.
--
-- Plan: .claude/plans/1-same-provider-as-greedy-hopcroft.md (Phase 6).
--
-- Three layers:
--   Command Hub (Exafy operators)  → BUILD: agent_personas, agent_tools,
--                                    agent_kb_bindings, audit_log.
--   Tenant Admin (tenant admins)   → CUSTOMIZE (this migration): the
--                                    overrides + tenant-scoped bindings.
--   Community User (mobile/voice)  → USE: voice handoff resolves the merged
--                                    platform+tenant view of "my team".

-- ===========================================================================
-- 1. agent_personas_tenant_overrides
-- ===========================================================================
-- Per-tenant persona overlay. Disabled here = persona invisible to tenant's
-- runtime even though it exists at the platform layer. intake_schema_extras
-- is appended to the persona's intake during voice intake for that tenant.
-- custom_greeting_templates lets a tenant give a specialist a tenant-flavoured
-- greeting (rare; most tenants accept the platform default).

CREATE TABLE IF NOT EXISTS public.agent_personas_tenant_overrides (
  tenant_id UUID NOT NULL,
  persona_id UUID NOT NULL REFERENCES public.agent_personas(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  intake_schema_extras JSONB NOT NULL DEFAULT '{}'::jsonb,
  custom_greeting_templates JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, persona_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_personas_tenant_overrides_tenant
  ON public.agent_personas_tenant_overrides (tenant_id) WHERE enabled = TRUE;

-- ===========================================================================
-- 2. agent_kb_bindings_tenant
-- ===========================================================================
-- Tenant attaches a KB scope (or a topic key) to a specialist's retrieval
-- chain. Common case: tenant's runbook KB → specialist 'devon' so that
-- Devon's RAG includes that tenant's internal docs when answering.
-- Differs from platform agent_kb_bindings (which gates the system / baseline
-- / 'tenant' literal scopes) in that this is per-tenant and finer-grained.

CREATE TABLE IF NOT EXISTS public.agent_kb_bindings_tenant (
  tenant_id UUID NOT NULL,
  persona_id UUID NOT NULL REFERENCES public.agent_personas(id) ON DELETE CASCADE,
  kb_scope TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  bound_by UUID,
  bound_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, persona_id, kb_scope)
);

CREATE INDEX IF NOT EXISTS idx_agent_kb_bindings_tenant_lookup
  ON public.agent_kb_bindings_tenant (tenant_id, persona_id) WHERE enabled = TRUE;

-- ===========================================================================
-- 3. agent_routing_keywords_tenant
-- ===========================================================================
-- Tenant adds tenant-scoped keywords. ADDITIVE on top of the platform
-- handoff_keywords from agent_personas — they don't replace, they extend.
-- Lets a tenant teach Atlas to recognize their company's jargon
-- ("Schadensmeldung" / "PEBKAC" / "purchase order") without affecting
-- other tenants.

CREATE TABLE IF NOT EXISTS public.agent_routing_keywords_tenant (
  tenant_id UUID NOT NULL,
  persona_id UUID NOT NULL REFERENCES public.agent_personas(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  weight REAL NOT NULL DEFAULT 1.0 CHECK (weight >= 0.0 AND weight <= 10.0),
  added_by UUID,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, persona_id, keyword)
);

CREATE INDEX IF NOT EXISTS idx_agent_routing_keywords_tenant_lookup
  ON public.agent_routing_keywords_tenant (tenant_id) WHERE enabled = TRUE;

-- ===========================================================================
-- 4. ALTER agent_third_party_connections — add tenant_id (currently platform)
-- ===========================================================================
-- Existing rows stay tenant_id=NULL (platform-default). Tenant rows get
-- tenant_id=X. Adapter resolution: prefer tenant_id=X row if present, else
-- fall back to NULL row (the platform default, e.g. an Exafy-shared sandbox
-- Stripe key for testing).

ALTER TABLE public.agent_third_party_connections
  ADD COLUMN IF NOT EXISTS tenant_id UUID;

CREATE INDEX IF NOT EXISTS idx_agent_third_party_connections_tenant_persona
  ON public.agent_third_party_connections (tenant_id, persona_id);

-- ===========================================================================
-- 5. RLS — tenant gating
-- ===========================================================================
-- All four tables: tenant admins see/write their own tenant's row; service
-- role does everything (used by gateway during runtime merge); platform
-- staff/Exafy operators query via service role from Command Hub.

-- Helper expression: is the auth.uid() a member of this tenant?
-- Mirrors the pattern used in kb_documents and other tenant-scoped tables.
-- (Assumes user_tenants(tenant_id, user_id) exists per memory.)

ALTER TABLE public.agent_personas_tenant_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS apto_tenant_member_select ON public.agent_personas_tenant_overrides;
CREATE POLICY apto_tenant_member_select ON public.agent_personas_tenant_overrides
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_tenants ut
    WHERE ut.tenant_id = agent_personas_tenant_overrides.tenant_id
      AND ut.user_id = auth.uid()
  ));
DROP POLICY IF EXISTS apto_service ON public.agent_personas_tenant_overrides;
CREATE POLICY apto_service ON public.agent_personas_tenant_overrides
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.agent_kb_bindings_tenant ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS akbt_tenant_member_select ON public.agent_kb_bindings_tenant;
CREATE POLICY akbt_tenant_member_select ON public.agent_kb_bindings_tenant
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_tenants ut
    WHERE ut.tenant_id = agent_kb_bindings_tenant.tenant_id
      AND ut.user_id = auth.uid()
  ));
DROP POLICY IF EXISTS akbt_service ON public.agent_kb_bindings_tenant;
CREATE POLICY akbt_service ON public.agent_kb_bindings_tenant
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.agent_routing_keywords_tenant ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS arkt_tenant_member_select ON public.agent_routing_keywords_tenant;
CREATE POLICY arkt_tenant_member_select ON public.agent_routing_keywords_tenant
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_tenants ut
    WHERE ut.tenant_id = agent_routing_keywords_tenant.tenant_id
      AND ut.user_id = auth.uid()
  ));
DROP POLICY IF EXISTS arkt_service ON public.agent_routing_keywords_tenant;
CREATE POLICY arkt_service ON public.agent_routing_keywords_tenant
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

GRANT SELECT ON public.agent_personas_tenant_overrides TO authenticated;
GRANT SELECT ON public.agent_kb_bindings_tenant TO authenticated;
GRANT SELECT ON public.agent_routing_keywords_tenant TO authenticated;

-- ===========================================================================
-- 6. pick_specialist_for_text — tenant-aware overload
-- ===========================================================================
-- Same shape as the existing platform-only function (added in
-- 20260429100000_vtid_02603_feedback_handoff.sql) but UNIONs the tenant's
-- own routing keywords (with weight) on top of platform handoff_keywords.
-- The tenant variant is a separate function so existing callers (Command
-- Hub, runtime sessions without tenant context) keep working unchanged.
--
-- Score formula is deliberately the same as the platform version so the
-- merged ranking is comparable across keyword sources.

CREATE OR REPLACE FUNCTION public.pick_specialist_for_text_tenant(
  p_text TEXT,
  p_tenant_id UUID
)
RETURNS TABLE (
  persona_key TEXT,
  matched_keyword TEXT,
  score INT,
  confidence REAL,
  source TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lower TEXT := lower(coalesce(p_text, ''));
BEGIN
  RETURN QUERY
  WITH platform_keywords AS (
    -- Platform handoff_keywords from agent_personas (same as platform version).
    SELECT
      ap.key AS persona_key,
      kw AS matched_keyword,
      array_length(ap.handoff_keywords, 1) AS total_keywords,
      'platform'::TEXT AS src,
      1.0::REAL AS weight
    FROM public.agent_personas ap
    CROSS JOIN LATERAL unnest(ap.handoff_keywords) AS kw
    WHERE ap.key <> 'vitana'
      AND ap.status = 'active'
      AND v_lower LIKE '%' || lower(kw) || '%'
  ),
  tenant_keywords AS (
    -- Tenant-scoped routing keywords on top of platform.
    SELECT
      ap.key AS persona_key,
      arkt.keyword AS matched_keyword,
      -- Treat each tenant keyword as one "slot" so the score formula stays
      -- comparable. total_keywords is set to a constant 1 here; we use
      -- weight to express tenant preference instead.
      1 AS total_keywords,
      'tenant'::TEXT AS src,
      arkt.weight AS weight
    FROM public.agent_routing_keywords_tenant arkt
    JOIN public.agent_personas ap ON ap.id = arkt.persona_id
    WHERE arkt.tenant_id = p_tenant_id
      AND arkt.enabled = TRUE
      AND ap.status = 'active'
      AND ap.key <> 'vitana'
      -- Honour tenant disable: if tenant has disabled the persona, skip.
      AND NOT EXISTS (
        SELECT 1 FROM public.agent_personas_tenant_overrides apto
        WHERE apto.tenant_id = p_tenant_id
          AND apto.persona_id = ap.id
          AND apto.enabled = FALSE
      )
      AND v_lower LIKE '%' || lower(arkt.keyword) || '%'
  ),
  combined AS (
    SELECT * FROM platform_keywords
    UNION ALL
    SELECT * FROM tenant_keywords
  ),
  scored AS (
    SELECT
      persona_key,
      sum(weight)::INT AS score,
      max(total_keywords) AS total_keywords,
      (array_agg(matched_keyword ORDER BY weight DESC, length(matched_keyword) DESC))[1] AS matched_keyword,
      (array_agg(src ORDER BY weight DESC, length(matched_keyword) DESC))[1] AS top_source
    FROM combined
    GROUP BY persona_key
  )
  SELECT
    s.persona_key,
    s.matched_keyword,
    s.score,
    (s.score::REAL / GREATEST(s.total_keywords, 1)::REAL) AS confidence,
    s.top_source AS source
  FROM scored s
  ORDER BY s.score DESC, length(s.matched_keyword) DESC
  LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.pick_specialist_for_text_tenant(TEXT, UUID)
  TO authenticated, service_role;

-- ===========================================================================
-- 7. Tenant audit log — extend existing agent_audit_log with tenant_id
-- ===========================================================================
-- Existing platform audit stays for Command Hub changes. Tenant changes
-- carry a non-NULL tenant_id and are queried by the tenant admin audit tab.

ALTER TABLE public.agent_audit_log
  ADD COLUMN IF NOT EXISTS tenant_id UUID;

CREATE INDEX IF NOT EXISTS idx_agent_audit_log_tenant
  ON public.agent_audit_log (tenant_id, ts DESC) WHERE tenant_id IS NOT NULL;

-- Action enum extension — add tenant-overlay-specific actions.
ALTER TABLE public.agent_audit_log DROP CONSTRAINT IF EXISTS agent_audit_log_action_check;
ALTER TABLE public.agent_audit_log
  ADD CONSTRAINT agent_audit_log_action_check
  CHECK (action IN (
    'persona_edit','voice_change','prompt_change','status_change',
    'tool_bind','tool_unbind','kb_bind','kb_unbind',
    'connection_add','connection_remove','connection_update',
    'rollback','routing_rule_change',
    -- Phase 6 — tenant overlay actions:
    'tenant_persona_enable','tenant_persona_disable','tenant_intake_extras_change',
    'tenant_kb_bind','tenant_kb_unbind',
    'tenant_keyword_add','tenant_keyword_remove',
    'tenant_connection_add','tenant_connection_remove',
    'persona_create','persona_archive','tool_register'
  ));
