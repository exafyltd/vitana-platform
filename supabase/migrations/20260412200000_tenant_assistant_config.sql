-- =============================================================================
-- Batch 1.B2: Per-tenant assistant configuration
--
-- Stores tenant-specific overrides for AI personality surfaces. The gateway's
-- getEffectiveConfig(surface, tenant_id) merges: defaults ← global ← tenant.
-- Maxina can override voice_live's system prompt without affecting Earthlinks.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.tenant_assistant_config (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               UUID NOT NULL REFERENCES public.tenants(id),
    surface_key             TEXT NOT NULL,
    system_prompt_override  TEXT,              -- overrides base_identity + general_behavior
    voice_config_override   JSONB,             -- voice ID, language, tone
    tool_overrides          JSONB,             -- per-tool allow/deny for this surface
    model_routing_override  JSONB,             -- model selection per surface
    extra_config            JSONB DEFAULT '{}', -- catch-all for surface-specific keys
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by              UUID,
    UNIQUE (tenant_id, surface_key)
);

CREATE INDEX IF NOT EXISTS idx_tenant_assistant_config_tenant
    ON public.tenant_assistant_config (tenant_id);

-- RLS
ALTER TABLE public.tenant_assistant_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.tenant_assistant_config
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "tenant_members_select" ON public.tenant_assistant_config
    FOR SELECT TO authenticated
    USING (
        tenant_id = (
            SELECT (raw_app_meta_data->>'active_tenant_id')::uuid
            FROM auth.users WHERE id = auth.uid()
        )
    );

COMMENT ON TABLE public.tenant_assistant_config IS 'Batch 1.B2: per-tenant AI personality overrides layered on global defaults';

-- =============================================================================
-- Batch 1.B2: Per-tenant knowledge base documents
--
-- tenant_id NULL = Exafy baseline (available to all tenants).
-- tenant_id SET = private to that tenant.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.kb_documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID REFERENCES public.tenants(id),  -- NULL = global baseline
    source          TEXT NOT NULL DEFAULT 'upload',       -- upload, url, baseline
    title           TEXT NOT NULL,
    body            TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',       -- pending, indexed, failed
    indexed_at      TIMESTAMPTZ,
    embedding_id    TEXT,                                  -- reference to vector store
    topics          TEXT[] DEFAULT '{}',
    visibility      JSONB DEFAULT '{}',                    -- which surfaces/roles can see
    created_by      UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_documents_tenant ON public.kb_documents (tenant_id);
CREATE INDEX IF NOT EXISTS idx_kb_documents_status ON public.kb_documents (status);
CREATE INDEX IF NOT EXISTS idx_kb_documents_topics ON public.kb_documents USING gin (topics);

-- RLS: tenant members see their own docs + baseline (tenant_id IS NULL)
ALTER TABLE public.kb_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.kb_documents
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "tenant_read" ON public.kb_documents
    FOR SELECT TO authenticated
    USING (
        tenant_id IS NULL  -- baseline docs visible to all
        OR tenant_id = (
            SELECT (raw_app_meta_data->>'active_tenant_id')::uuid
            FROM auth.users WHERE id = auth.uid()
        )
    );

CREATE POLICY "tenant_admin_write" ON public.kb_documents
    FOR INSERT TO authenticated
    WITH CHECK (
        tenant_id = (
            SELECT (raw_app_meta_data->>'active_tenant_id')::uuid
            FROM auth.users WHERE id = auth.uid()
        )
    );

CREATE POLICY "tenant_admin_update" ON public.kb_documents
    FOR UPDATE TO authenticated
    USING (
        tenant_id = (
            SELECT (raw_app_meta_data->>'active_tenant_id')::uuid
            FROM auth.users WHERE id = auth.uid()
        )
    );

CREATE POLICY "tenant_admin_delete" ON public.kb_documents
    FOR DELETE TO authenticated
    USING (
        tenant_id = (
            SELECT (raw_app_meta_data->>'active_tenant_id')::uuid
            FROM auth.users WHERE id = auth.uid()
        )
    );

COMMENT ON TABLE public.kb_documents IS 'Batch 1.B2: per-tenant knowledge base. tenant_id NULL = global baseline, non-null = tenant-private';

-- =============================================================================
-- Tenant KB baseline opt-outs
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.tenant_kb_baseline_optouts (
    tenant_id       UUID NOT NULL REFERENCES public.tenants(id),
    document_id     UUID NOT NULL REFERENCES public.kb_documents(id),
    opted_out_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    opted_out_by    UUID,
    PRIMARY KEY (tenant_id, document_id)
);

ALTER TABLE public.tenant_kb_baseline_optouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.tenant_kb_baseline_optouts
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.tenant_kb_baseline_optouts IS 'Batch 1.B2: lets tenants opt out of specific global KB documents';
