-- Purpose: VTID-03932 Commerce Partner Onboarding (Phase 1) — self-service
--          partner business identity, org-scoped staff/professional roster,
--          and automatic Vitana-wide `patient` activation on first health
--          service order.
-- Date: 2026-09-15
--
-- Builds on VTID-03885 (Partner Health Test Integration) and VTID-03832
-- (backoffice role ladder), reusing both rather than duplicating them:
--   - `partner_registry` (health-integration capabilities) gets a new
--     nullable FK to the new `partner_organizations` (business identity) —
--     it is NOT replaced or renamed.
--   - Patient activation reuses the EXISTING `memberships`/`tenant_role`
--     ladder (community < patient < ... ) instead of inventing a second
--     parallel status flag. The ladder's live shape (memberships.user_id/
--     tenant_id/role/status) is read-only inferred from
--     services/gateway/src/routes/auth.ts's GET /me response contract —
--     this migration does not create or alter `memberships` itself, and
--     the trigger below is defensive (wrapped in EXCEPTION) so a live-schema
--     surprise there can never break a partner health order insert.
--
-- Per the user-approved plan: `partner_organizations` is a deliberately
-- SEPARATE, parallel concept from `tenants` (the small, fixed set of
-- Vitana-operated white-label portal brands) — org-scoped roles
-- (org_admin/staff/professional) are a different dimension from
-- `vitana_role`/`tenant_role` and are NOT stored in that enum.

-- ===========================================================================
-- 1. partner_organizations — the self-registered business identity
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.partner_organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_key TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    -- Free-text by convention (matches partner_registry.integration_mode's
    -- own pattern) so a brand-new vertical never needs a migration to add
    -- a type: 'commerce' | 'lab_partner' | 'wellness_partner' |
    -- 'medical_partner' | ...
    org_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_review'
        CHECK (status IN ('pending_review', 'active', 'suspended', 'rejected')),
    owner_user_id UUID NOT NULL,
    business_details JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS partner_organizations_owner_idx ON public.partner_organizations (owner_user_id);
CREATE INDEX IF NOT EXISTS partner_organizations_status_idx ON public.partner_organizations (status);

COMMENT ON TABLE public.partner_organizations IS 'VTID-03932: self-registered commerce/health/wellness partner business identity. Deliberately separate from public.tenants (Vitana-operated portal brands) — see plan decision recorded in vitana-platform CLAUDE.md CHANGE LOG.';

-- partner_registry (VTID-03885) gets a nullable link once a partner org
-- needs the health-specific webhook/API integration capabilities that
-- table already models.
ALTER TABLE public.partner_registry
    ADD COLUMN IF NOT EXISTS partner_organization_id UUID REFERENCES public.partner_organizations(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.partner_registry.partner_organization_id IS 'VTID-03932: set once this integration-layer partner has a self-registered partner_organizations business identity. Nullable — hand-seeded partners (DoctorBox pre-VTID-03932) may have none yet.';

-- ===========================================================================
-- 2. partner_organization_members — the org's own staff/professional roster
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.partner_organization_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_organization_id UUID NOT NULL REFERENCES public.partner_organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    -- Deliberately NOT the vitana_role/tenant_role enum — org-scoped roles
    -- are a separate dimension from the Vitana-portal role ladder.
    role TEXT NOT NULL CHECK (role IN ('org_admin', 'staff', 'professional')),
    granted_by UUID,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT partner_organization_members_org_user_uidx UNIQUE (partner_organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS partner_organization_members_user_idx ON public.partner_organization_members (user_id);

COMMENT ON TABLE public.partner_organization_members IS 'VTID-03932: a partner org''s own staff roster. role is org-scoped (org_admin/staff/professional), independent of the Vitana-wide vitana_role/tenant_role ladder every member also carries via their normal community account.';

-- ===========================================================================
-- 3. partner_organization_invites — invite-to-join-org flow
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.partner_organization_invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_organization_id UUID NOT NULL REFERENCES public.partner_organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('org_admin', 'staff', 'professional')),
    invited_by UUID NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS partner_organization_invites_org_idx ON public.partner_organization_invites (partner_organization_id);
CREATE INDEX IF NOT EXISTS partner_organization_invites_pending_idx
    ON public.partner_organization_invites (email) WHERE accepted_at IS NULL;

COMMENT ON TABLE public.partner_organization_invites IS 'VTID-03932: lets an org_admin invite someone (with or without an existing Vitana account) to join the org at a given org-scoped role. Redeeming the token inserts the partner_organization_members row.';

-- ===========================================================================
-- 4. patient_profiles — Vitana-wide `patient` activation, never org-scoped
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.patient_profiles (
    user_id UUID PRIMARY KEY,
    activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    activation_reason TEXT NOT NULL DEFAULT 'partner_order'
        CHECK (activation_reason IN ('partner_order', 'vitana_service'))
);

COMMENT ON TABLE public.patient_profiles IS 'VTID-03932: marks a user as having consumed at least one medical/health service, Vitana-wide (never scoped to a single partner org). Set automatically by the AFTER INSERT trigger on partner_health_test_orders below — never granted by a partner or an admin.';

-- ===========================================================================
-- 5. Order-scoped professional assignment on partner_health_test_orders
-- ===========================================================================

ALTER TABLE public.partner_health_test_orders
    ADD COLUMN IF NOT EXISTS assigned_professional_user_id UUID;

COMMENT ON COLUMN public.partner_health_test_orders.assigned_professional_user_id IS 'VTID-03932: the partner org professional (partner_organization_members.role=professional) assigned to handle this specific order. Order-scoped, least-privilege — a professional can act on exactly the orders assigned to them, not a standing patient relationship. Nullable FK omitted deliberately (auth.users lives outside public schema); enforced at the route layer.';

CREATE INDEX IF NOT EXISTS partner_health_test_orders_assigned_professional_idx
    ON public.partner_health_test_orders (assigned_professional_user_id) WHERE assigned_professional_user_id IS NOT NULL;

-- ===========================================================================
-- 6. patient_profiles activation trigger — fires on every new health order
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.trg_activate_patient_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- 1. Vitana-wide patient activation — idempotent, first order only.
    INSERT INTO public.patient_profiles (user_id, activation_reason)
    VALUES (NEW.user_id, 'partner_order')
    ON CONFLICT (user_id) DO NOTHING;

    -- 2. Best-effort ladder bump: only community -> patient, never a
    -- downgrade of someone already staff/admin/etc. Wrapped defensively —
    -- the live `memberships` table's exact shape is inferred from
    -- services/gateway/src/routes/auth.ts's GET /me contract, not created
    -- by a migration in this repo (per vitana-platform CLAUDE.md §3's own
    -- warning that live DB state can outrun this repo's migration history).
    -- A failure here must never roll back the order insert itself.
    BEGIN
        UPDATE public.memberships
        SET role = 'patient'
        WHERE user_id = NEW.user_id
          AND tenant_id = NEW.tenant_id
          AND role = 'community'
          AND status = 'active';
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'VTID-03932: patient ladder bump skipped for user % (%): %', NEW.user_id, SQLSTATE, SQLERRM;
    END;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trg_activate_patient_profile() IS 'VTID-03932: AFTER INSERT on partner_health_test_orders. Grants Vitana-wide patient_profiles activation and (best-effort) bumps the ordering user''s tenant_role ladder from community to patient. Never downgrades staff/admin/etc; never org-scoped.';

DROP TRIGGER IF EXISTS trg_partner_health_test_orders_activate_patient ON public.partner_health_test_orders;
CREATE TRIGGER trg_partner_health_test_orders_activate_patient
    AFTER INSERT ON public.partner_health_test_orders
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_activate_patient_profile();

-- ===========================================================================
-- 7. RLS — enable everywhere; writes happen via the gateway's service-role
--    client (bypasses RLS by design, per platform convention). These
--    policies are defense-in-depth for any future direct-client read.
-- ===========================================================================

ALTER TABLE public.partner_organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_organization_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_profiles ENABLE ROW LEVEL SECURITY;

-- partner_organizations: any authenticated user can see active orgs (like
-- merchants/partner_registry); an org's own owner/members can see it
-- regardless of status (e.g. while still pending_review).
DROP POLICY IF EXISTS partner_organizations_select ON public.partner_organizations;
CREATE POLICY partner_organizations_select ON public.partner_organizations
    FOR SELECT USING (
        status = 'active'
        OR owner_user_id = public.current_user_id()
        OR EXISTS (
            SELECT 1 FROM public.partner_organization_members pom
            WHERE pom.partner_organization_id = partner_organizations.id
              AND pom.user_id = public.current_user_id()
        )
    );

-- partner_organization_members: a member can see their own org's roster.
DROP POLICY IF EXISTS partner_organization_members_select ON public.partner_organization_members;
CREATE POLICY partner_organization_members_select ON public.partner_organization_members
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.partner_organization_members pom
            WHERE pom.partner_organization_id = partner_organization_members.partner_organization_id
              AND pom.user_id = public.current_user_id()
        )
    );

-- partner_organization_invites: internal/admin only — no direct-client
-- read policy (invite tokens are sensitive). RLS enabled with no policy,
-- same pattern as partner_customer_links/partner_health_result_inbox
-- (VTID-03885).

-- patient_profiles: user reads their own activation row only.
DROP POLICY IF EXISTS patient_profiles_select ON public.patient_profiles;
CREATE POLICY patient_profiles_select ON public.patient_profiles
    FOR SELECT USING (user_id = public.current_user_id());
