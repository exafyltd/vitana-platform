-- =============================================================================
-- Fix: Create admin tables with correct FK reference
--
-- The live tenants table uses tenant_id as PK (not id as in the bootstrap
-- migration file). This migration handles both cases and ensures all
-- admin tables exist with correct references.
-- =============================================================================

-- Step 1: Detect the actual PK column name and create tenant_settings
DO $$
DECLARE
    v_pk_col TEXT;
    v_maxina_id UUID;
BEGIN
    -- Find the actual PK column of public.tenants
    SELECT a.attname INTO v_pk_col
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'public.tenants'::regclass AND i.indisprimary;

    RAISE NOTICE 'Tenants PK column: %', v_pk_col;

    -- Create tenant_settings if not exists (no FK — we manage referential integrity at app level)
    CREATE TABLE IF NOT EXISTS public.tenant_settings (
        tenant_id       UUID PRIMARY KEY,
        profile         JSONB NOT NULL DEFAULT '{}',
        branding        JSONB NOT NULL DEFAULT '{}',
        feature_flags   JSONB NOT NULL DEFAULT '{}',
        integrations    JSONB NOT NULL DEFAULT '{}',
        domains         JSONB NOT NULL DEFAULT '{}',
        billing         JSONB NOT NULL DEFAULT '{}',
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_by      UUID
    );

    -- Create tenant_admin_audit_log if not exists
    CREATE TABLE IF NOT EXISTS public.tenant_admin_audit_log (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       UUID NOT NULL,
        actor_user_id   UUID NOT NULL,
        action          TEXT NOT NULL,
        target_resource TEXT,
        before_state    JSONB,
        after_state     JSONB,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Create tenant_assistant_config if not exists
    CREATE TABLE IF NOT EXISTS public.tenant_assistant_config (
        id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id               UUID NOT NULL,
        surface_key             TEXT NOT NULL,
        system_prompt_override  TEXT,
        voice_config_override   JSONB,
        tool_overrides          JSONB,
        model_routing_override  JSONB,
        extra_config            JSONB DEFAULT '{}',
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_by              UUID,
        UNIQUE (tenant_id, surface_key)
    );

    -- Create kb_documents if not exists
    CREATE TABLE IF NOT EXISTS public.kb_documents (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       UUID,
        source          TEXT NOT NULL DEFAULT 'upload',
        title           TEXT NOT NULL,
        body            TEXT,
        status          TEXT NOT NULL DEFAULT 'pending',
        indexed_at      TIMESTAMPTZ,
        embedding_id    TEXT,
        topics          TEXT[] DEFAULT '{}',
        visibility      JSONB DEFAULT '{}',
        created_by      UUID,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Create tenant_kb_baseline_optouts if not exists
    CREATE TABLE IF NOT EXISTS public.tenant_kb_baseline_optouts (
        tenant_id       UUID NOT NULL,
        document_id     UUID NOT NULL,
        opted_out_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        opted_out_by    UUID,
        PRIMARY KEY (tenant_id, document_id)
    );

    -- Create tenant_invitations if not exists
    CREATE TABLE IF NOT EXISTS public.tenant_invitations (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       UUID NOT NULL,
        email           TEXT NOT NULL,
        roles           TEXT[] NOT NULL DEFAULT ARRAY['community'],
        token           TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
        invited_by      UUID NOT NULL,
        message         TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '7 days',
        accepted_at     TIMESTAMPTZ,
        accepted_by     UUID,
        revoked_at      TIMESTAMPTZ,
        revoked_by      UUID
    );

    -- Seed Maxina tenant_settings using the actual PK value
    IF v_pk_col = 'id' THEN
        EXECUTE 'SELECT id FROM public.tenants WHERE slug = $1' INTO v_maxina_id USING 'maxina';
    ELSE
        EXECUTE 'SELECT tenant_id FROM public.tenants WHERE slug = $1' INTO v_maxina_id USING 'maxina';
    END IF;

    RAISE NOTICE 'Maxina tenant UUID: %', v_maxina_id;

    IF v_maxina_id IS NOT NULL THEN
        INSERT INTO public.tenant_settings (tenant_id, profile, branding, feature_flags, integrations, domains, billing)
        VALUES (
            v_maxina_id,
            '{"name": "Maxina", "description": "Maxina Longevity Community", "support_email": "support@vitanaland.com"}'::jsonb,
            '{"brand_accent": "#FF7BAC", "brand_bg": "#FFF5F8", "brand_fg": "#1a1a2e"}'::jsonb,
            '{"enable_voice_widget": true, "enable_autopilot": true, "enable_knowledge_base": true, "enable_navigator": true, "enable_notifications": true}'::jsonb,
            '{}'::jsonb,
            '{"primary_domain": "vitanaland.com"}'::jsonb,
            '{"plan": "enterprise", "usage_limits": {"members": 1000, "kb_documents": 500, "autopilot_actions_per_day": 100}}'::jsonb
        )
        ON CONFLICT (tenant_id) DO UPDATE SET
            profile = EXCLUDED.profile,
            branding = EXCLUDED.branding,
            feature_flags = EXCLUDED.feature_flags,
            domains = EXCLUDED.domains,
            billing = EXCLUDED.billing,
            updated_at = now();
        RAISE NOTICE 'Maxina tenant_settings seeded/updated';
    ELSE
        RAISE WARNING 'Maxina tenant not found in tenants table!';
    END IF;
END $$;

-- RLS for all new tables
ALTER TABLE public.tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_admin_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_assistant_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_kb_baseline_optouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_invitations ENABLE ROW LEVEL SECURITY;

-- Service role policies (gateway uses service role)
DO $$ BEGIN
    CREATE POLICY "service_all" ON public.tenant_settings FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE POLICY "service_all" ON public.tenant_admin_audit_log FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE POLICY "service_all" ON public.tenant_assistant_config FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE POLICY "service_all" ON public.kb_documents FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE POLICY "service_all" ON public.tenant_kb_baseline_optouts FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE POLICY "service_all" ON public.tenant_invitations FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tenant_admin_audit_tenant ON public.tenant_admin_audit_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_assistant_config_tenant ON public.tenant_assistant_config (tenant_id);
CREATE INDEX IF NOT EXISTS idx_kb_documents_tenant ON public.kb_documents (tenant_id);
CREATE INDEX IF NOT EXISTS idx_kb_documents_status ON public.kb_documents (status);
CREATE INDEX IF NOT EXISTS idx_tenant_invitations_tenant ON public.tenant_invitations (tenant_id, created_at DESC);

-- Force PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';
