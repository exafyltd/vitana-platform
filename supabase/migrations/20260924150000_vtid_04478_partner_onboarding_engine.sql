-- Purpose: VTID-04478 Commerce partner onboarding, Phase 1: onboarding engine
--          storage (docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md §6.1/§6.2).
-- Date: 2026-09-24
--
-- 1. partner_onboarding_steps — one row per (org, step) for the steps a
--    dedicated endpoint decides: verification, catalogue, mapping, tracking
--    test, results channel, DPA, billing mandate. The engine derives account,
--    company, terms and team itself and never reads a row for them.
-- 2. partner_terms_acceptances — the audit record of a terms acceptance:
--    version, time, user, IP and user agent (spec §6.2 terms/accept).
--
-- Both are written only by the gateway (service role). Members of the org
-- may read their own org's rows through the VTID-04337 membership helper.

CREATE TABLE IF NOT EXISTS public.partner_onboarding_steps (
    partner_organization_id UUID NOT NULL REFERENCES public.partner_organizations(id) ON DELETE CASCADE,
    step_key TEXT NOT NULL CHECK (step_key IN (
        'verification', 'catalogue', 'mapping', 'tracking_test', 'results_channel', 'dpa', 'billing_mandate'
    )),
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done', 'failed', 'not_required')),
    detail JSONB NOT NULL DEFAULT '{}'::JSONB,
    updated_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (partner_organization_id, step_key)
);

COMMENT ON TABLE public.partner_onboarding_steps IS 'VTID-04478: per-org status of the onboarding steps a dedicated endpoint decides (spec §6.1). account/company/terms/team are derived by the gateway and never stored here. Written by the gateway only.';

CREATE TABLE IF NOT EXISTS public.partner_terms_acceptances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_organization_id UUID NOT NULL REFERENCES public.partner_organizations(id) ON DELETE CASCADE,
    terms_version TEXT NOT NULL,
    accepted_by UUID NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip_address TEXT,
    user_agent TEXT,
    CONSTRAINT partner_terms_acceptances_org_version_uidx UNIQUE (partner_organization_id, terms_version)
);

COMMENT ON TABLE public.partner_terms_acceptances IS 'VTID-04478: audit record of a partner org accepting a version of the partner terms (spec §6.2): who, when, from which IP/user agent. One row per org and version. Written by the gateway only.';

ALTER TABLE public.partner_onboarding_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_terms_acceptances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_onboarding_steps_select ON public.partner_onboarding_steps;
CREATE POLICY partner_onboarding_steps_select ON public.partner_onboarding_steps
    FOR SELECT TO authenticated
    USING (public.is_partner_org_member(partner_organization_id));

DROP POLICY IF EXISTS partner_terms_acceptances_select ON public.partner_terms_acceptances;
CREATE POLICY partner_terms_acceptances_select ON public.partner_terms_acceptances
    FOR SELECT TO authenticated
    USING (public.is_partner_org_member(partner_organization_id));

REVOKE INSERT, UPDATE, DELETE ON public.partner_onboarding_steps FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.partner_terms_acceptances FROM anon, authenticated;
