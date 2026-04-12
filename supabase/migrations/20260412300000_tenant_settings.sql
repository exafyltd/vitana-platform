-- =============================================================================
-- Settings section: tenant_settings table
--
-- Stores per-tenant profile, branding, feature flags, integrations.
-- useTenant() in vitana-v1 reads branding from here instead of hardcoded.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.tenant_settings (
    tenant_id       UUID PRIMARY KEY REFERENCES public.tenants(id),
    profile         JSONB NOT NULL DEFAULT '{}',    -- name, description, support_email, logo_url
    branding        JSONB NOT NULL DEFAULT '{}',    -- brand_accent, brand_bg, brand_fg, favicon_url
    feature_flags   JSONB NOT NULL DEFAULT '{}',    -- enable_voice_widget, enable_autopilot, etc.
    integrations    JSONB NOT NULL DEFAULT '{}',    -- webhook_urls, api_keys (encrypted refs), external services
    domains         JSONB NOT NULL DEFAULT '{}',    -- custom_domain, subdomain, dns_status
    billing         JSONB NOT NULL DEFAULT '{}',    -- plan, usage_limits, current_usage (read-only from admin)
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      UUID
);

ALTER TABLE public.tenant_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.tenant_settings
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "tenant_read" ON public.tenant_settings
    FOR SELECT TO authenticated
    USING (
        tenant_id = (
            SELECT (raw_app_meta_data->>'active_tenant_id')::uuid
            FROM auth.users WHERE id = auth.uid()
        )
    );

COMMENT ON TABLE public.tenant_settings IS 'Per-tenant settings: profile, branding, feature flags, integrations, domains, billing';

-- =============================================================================
-- Audit section: tenant_admin_audit_log
--
-- Every mutating admin action is recorded here with actor, target,
-- before/after diff. Populated by gateway middleware.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.tenant_admin_audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES public.tenants(id),
    actor_user_id   UUID NOT NULL,
    action          TEXT NOT NULL,           -- e.g. 'role.grant', 'invitation.create', 'settings.update'
    target_resource TEXT,                    -- e.g. 'user:<uuid>', 'invitation:<uuid>', 'settings'
    before_state    JSONB,
    after_state     JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_admin_audit_tenant
    ON public.tenant_admin_audit_log (tenant_id, created_at DESC);

ALTER TABLE public.tenant_admin_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.tenant_admin_audit_log
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "tenant_read" ON public.tenant_admin_audit_log
    FOR SELECT TO authenticated
    USING (
        tenant_id = (
            SELECT (raw_app_meta_data->>'active_tenant_id')::uuid
            FROM auth.users WHERE id = auth.uid()
        )
    );

COMMENT ON TABLE public.tenant_admin_audit_log IS 'Audit trail of all tenant-admin actions with before/after diffs';
