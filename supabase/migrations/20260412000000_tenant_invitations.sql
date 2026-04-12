-- =============================================================================
-- Batch 1.B1: tenant_invitations table
--
-- Allows tenant admins to invite users by email, offering one or more roles.
-- Accept flow: POST /api/v1/admin/invitations/accept/:token → auto-grants
-- the offered roles via the existing /api/v1/roles/grant endpoint internally.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.tenant_invitations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES public.tenants(id),
    email           TEXT NOT NULL,
    roles           TEXT[] NOT NULL DEFAULT ARRAY['community'],
    token           TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
    invited_by      UUID NOT NULL,
    message         TEXT,                                -- optional personal note
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '7 days',
    accepted_at     TIMESTAMPTZ,
    accepted_by     UUID,
    revoked_at      TIMESTAMPTZ,
    revoked_by      UUID
);

-- Index for token lookup (accept flow)
CREATE INDEX IF NOT EXISTS idx_tenant_invitations_token
    ON public.tenant_invitations (token)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Index for tenant admin listing
CREATE INDEX IF NOT EXISTS idx_tenant_invitations_tenant
    ON public.tenant_invitations (tenant_id, created_at DESC);

-- RLS: tenant admins see only their own tenant's invitations
ALTER TABLE public.tenant_invitations ENABLE ROW LEVEL SECURITY;

-- Service role bypass (used by gateway)
CREATE POLICY "service_role_all" ON public.tenant_invitations
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Authenticated users can view invitations for their active tenant
CREATE POLICY "tenant_members_select" ON public.tenant_invitations
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = (
            SELECT (raw_app_meta_data->>'active_tenant_id')::uuid
            FROM auth.users
            WHERE id = auth.uid()
        )
    );

-- Only tenant admins can insert (enforced at gateway level, but belt-and-suspenders)
CREATE POLICY "tenant_admin_insert" ON public.tenant_invitations
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = (
            SELECT (raw_app_meta_data->>'active_tenant_id')::uuid
            FROM auth.users
            WHERE id = auth.uid()
        )
        AND EXISTS (
            SELECT 1 FROM public.user_tenants
            WHERE user_id = auth.uid()
              AND tenant_id = tenant_invitations.tenant_id
              AND active_role = 'admin'
        )
    );

COMMENT ON TABLE public.tenant_invitations IS 'Batch 1.B1: invitation system for tenant admins to invite users by email with specific roles';
