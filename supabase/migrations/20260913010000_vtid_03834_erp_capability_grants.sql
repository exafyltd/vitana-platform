-- VTID-03834 — ERP capability grants for the Vitanaland BackOffice
--
-- The Vitana ROLE (`backoffice`, VTID-03832) opens the /backoffice door; a CAPABILITY
-- (`crm.manage`, `finance.pay`, `accounting.close`, … — catalog in
-- services/gateway/src/constants/erp-capabilities.ts, design gate GOLDEN-WORKFLOWS.md §3)
-- gates what a person may do inside. Role defaults are computed in the gateway; this table
-- holds only EXPLICIT grants (one row per user × tenant × capability), written exclusively
-- through POST /api/v1/backoffice/access/grant|revoke with the service role — never from a
-- browser. Same shape and posture as user_permitted_roles (VTID-01230).
--
-- NOT APPLIED by the session that wrote it (execution-brief rule 4: DDL on the single
-- Supabase project needs the platform owner's explicit "apply now").

CREATE TABLE IF NOT EXISTS public.erp_capability_grants (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL,
    tenant_id   UUID NOT NULL,
    capability  TEXT NOT NULL,
    granted_by  UUID,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT erp_capability_grants_unique UNIQUE (user_id, tenant_id, capability),
    -- catalog shape only (`<domain>.<level>`); the gateway validates against the real catalog
    CONSTRAINT erp_capability_grants_capability_shape CHECK (capability ~ '^[a-z]+\.[a-z_]+$')
);

CREATE INDEX IF NOT EXISTS idx_erp_capability_grants_user_tenant ON public.erp_capability_grants (user_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_erp_capability_grants_tenant ON public.erp_capability_grants (tenant_id);

ALTER TABLE public.erp_capability_grants ENABLE ROW LEVEL SECURITY;

-- A user may read their own grants (the frontend reads effective access via the gateway anyway)
DROP POLICY IF EXISTS ecg_select_own ON public.erp_capability_grants;
CREATE POLICY ecg_select_own ON public.erp_capability_grants
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

-- All writes go through the gateway's service role
DROP POLICY IF EXISTS ecg_all_service_role ON public.erp_capability_grants;
CREATE POLICY ecg_all_service_role ON public.erp_capability_grants
    FOR ALL TO service_role
    USING (true) WITH CHECK (true);

GRANT SELECT ON public.erp_capability_grants TO authenticated;
GRANT ALL ON public.erp_capability_grants TO service_role;

COMMENT ON TABLE public.erp_capability_grants IS
  'VTID-03834: explicit ERP capability grants per user × tenant for the BackOffice; role defaults live in the gateway; written only via /api/v1/backoffice/access/*';
