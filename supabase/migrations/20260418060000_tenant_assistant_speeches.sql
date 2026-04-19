-- =============================================================================
-- Phase 1: Per-tenant assistant speeches
--
-- Stores tenant-specific overrides for the named assistant speeches defined
-- in services/gateway/src/services/assistant-speeches/registry.ts.
-- The gateway resolves: registry default ← tenant override.
--
-- Mirrors the RLS pattern in 20260412200000_tenant_assistant_config.sql.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.tenant_assistant_speeches (
    tenant_id   UUID NOT NULL REFERENCES public.tenants(id),
    speech_key  TEXT NOT NULL,
    text        TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  UUID,
    PRIMARY KEY (tenant_id, speech_key)
);

CREATE INDEX IF NOT EXISTS idx_tenant_assistant_speeches_tenant
    ON public.tenant_assistant_speeches (tenant_id);

ALTER TABLE public.tenant_assistant_speeches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.tenant_assistant_speeches
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "tenant_members_select" ON public.tenant_assistant_speeches
    FOR SELECT TO authenticated
    USING (
        tenant_id = (
            SELECT (raw_app_meta_data->>'active_tenant_id')::uuid
            FROM auth.users WHERE id = auth.uid()
        )
    );

COMMENT ON TABLE public.tenant_assistant_speeches IS
    'Phase 1: per-tenant overrides for named assistant speeches (registry-backed).';

-- =============================================================================
-- Audit log for assistant speech changes (mirrors ai_personality_config_audit)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.assistant_speech_audit (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL,
    speech_key  TEXT NOT NULL,
    from_text   TEXT,
    to_text     TEXT,
    action      TEXT NOT NULL,           -- 'upsert' | 'reset'
    updated_by  UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assistant_speech_audit_tenant
    ON public.assistant_speech_audit (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_assistant_speech_audit_key
    ON public.assistant_speech_audit (speech_key, created_at DESC);

ALTER TABLE public.assistant_speech_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.assistant_speech_audit
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "tenant_members_select" ON public.assistant_speech_audit
    FOR SELECT TO authenticated
    USING (
        tenant_id = (
            SELECT (raw_app_meta_data->>'active_tenant_id')::uuid
            FROM auth.users WHERE id = auth.uid()
        )
    );

COMMENT ON TABLE public.assistant_speech_audit IS
    'Phase 1: audit trail of tenant assistant speech overrides (upsert/reset).';
