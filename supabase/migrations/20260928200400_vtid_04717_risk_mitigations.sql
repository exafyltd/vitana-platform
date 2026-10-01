-- VTID-04717: D49 Risk Mitigation data layer.
-- services/d49-risk-mitigation-engine(.ts|-repository.ts) has read and written
-- public.risk_mitigations since VTID-01143, but no migration ever created the
-- table, so every generate/list/dismiss call failed. Columns are exactly what
-- the engine writes (insertRiskMitigation / dismiss / acknowledge / expire)
-- and the fields of RiskMitigationSchema in types/risk-mitigation.ts.
--
-- Deliberately NOT done here: attaching trg_notify_risk_mitigation
-- (20260225200000_notification_db_triggers.sql creates it only when this
-- table exists). That trigger pushes a notification to the member on every
-- active mitigation; turning it on is a product decision, not a side effect
-- of creating the table.

CREATE TABLE IF NOT EXISTS public.risk_mitigations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    risk_window_id UUID NOT NULL,
    domain TEXT NOT NULL CHECK (domain IN ('sleep','nutrition','movement','mental','routine','social')),
    confidence NUMERIC NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
    suggested_adjustment TEXT NOT NULL,
    why_this_helps TEXT NOT NULL,
    effort_level TEXT NOT NULL DEFAULT 'low' CHECK (effort_level IN ('low','medium','high')),
    source_signals UUID[] NOT NULL DEFAULT '{}',
    precedent_type TEXT CHECK (precedent_type IS NULL OR precedent_type IN ('user_history','general_safety')),
    disclaimer TEXT NOT NULL DEFAULT 'This is a gentle suggestion, not medical advice. Feel free to dismiss if not relevant.',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dismissed','acknowledged','expired','superseded')),
    expires_at TIMESTAMPTZ,
    dismissed_at TIMESTAMPTZ,
    dismiss_reason TEXT,
    acknowledged_at TIMESTAMPTZ,
    generated_by_version TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    suggestion_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_risk_mitigations_user_status ON public.risk_mitigations (user_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_risk_mitigations_user_created ON public.risk_mitigations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_mitigations_dedupe ON public.risk_mitigations (user_id, domain, suggestion_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_mitigations_active_expiry ON public.risk_mitigations (expires_at) WHERE status = 'active';

-- Membership check for the insert policy. SECURITY DEFINER so the policy
-- does not depend on the caller's own grants/RLS on user_tenants.
CREATE OR REPLACE FUNCTION public.caller_is_tenant_member(p_tenant_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
    SELECT EXISTS (
        SELECT 1 FROM public.user_tenants ut
        WHERE ut.user_id = auth.uid() AND ut.tenant_id = p_tenant_id
    );
$fn$;
REVOKE ALL ON FUNCTION public.caller_is_tenant_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.caller_is_tenant_member(UUID) TO authenticated, service_role;

ALTER TABLE public.risk_mitigations ENABLE ROW LEVEL SECURITY;

-- A member sees and changes only their own rows, and may only write rows for
-- a tenant they belong to.
DROP POLICY IF EXISTS risk_mitigations_select_own ON public.risk_mitigations;
CREATE POLICY risk_mitigations_select_own ON public.risk_mitigations
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS risk_mitigations_insert_own ON public.risk_mitigations;
CREATE POLICY risk_mitigations_insert_own ON public.risk_mitigations
    FOR INSERT TO authenticated
    WITH CHECK (
        user_id = auth.uid()
        AND public.caller_is_tenant_member(tenant_id)
    );

DROP POLICY IF EXISTS risk_mitigations_update_own ON public.risk_mitigations;
CREATE POLICY risk_mitigations_update_own ON public.risk_mitigations
    FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS risk_mitigations_all_service_role ON public.risk_mitigations;
CREATE POLICY risk_mitigations_all_service_role ON public.risk_mitigations
    FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON public.risk_mitigations TO authenticated;
GRANT ALL ON public.risk_mitigations TO service_role;

COMMENT ON TABLE public.risk_mitigations IS 'VTID-04717 (engine VTID-01143, D49): low-effort risk mitigation suggestions per member; dismissible, expiring, deterministic (input_hash).';
