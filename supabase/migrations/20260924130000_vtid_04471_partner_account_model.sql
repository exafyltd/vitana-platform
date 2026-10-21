-- Purpose: VTID-04471 Commerce partner onboarding, Phase 1: the partner
--          account model (docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md §5.1/§5.2).
-- Date: 2026-09-24
--
-- partner_organizations becomes the root every partner record hangs off:
--   1. partner_type    enforced vocabulary; derives commerce_vertical
--   2. lifecycle_state draft → submitted → verifying → live (+ needs_action,
--                      exception, rejected, paused, suspended)
--   3. legal_name, country, vat_id, website, trust_level
--   4. merchants.partner_organization_id (the VCAOP partner_tenant link is in
--      prisma/migrations/20260924_vcaop_partner_org_link_0007, because that
--      table is Prisma-managed)
--   5. a backfill that gives every owned merchant without an org a
--      one-member org
--
-- The legacy `status` column stays and is kept in sync by a trigger, in both
-- directions, so the existing writers (/register sets 'pending_review',
-- /:orgId/activate sets 'active') and readers (/mine, the commerce specialist,
-- the frontend) keep working unchanged until they move to lifecycle_state.
--
-- Which transitions are allowed is enforced in the gateway
-- (services/partner-lifecycle.ts), not here. The DB only guarantees that
-- every value is valid and that the two columns agree.
--
-- Live state checked read-only before writing this (2026-09-24):
-- 0 partner_organizations, 0 merchants with an owner_user_id,
-- 0 partner_tenant rows. The backfill is therefore a no-op on the live
-- project today; it is written to be idempotent for when it is not.

-- ===========================================================================
-- 1. New columns on partner_organizations
-- ===========================================================================

ALTER TABLE public.partner_organizations
    ADD COLUMN IF NOT EXISTS partner_type TEXT
        CONSTRAINT partner_organizations_partner_type_check
        CHECK (partner_type IN ('lab', 'supplier_shop', 'practitioner_clinic', 'service_provider', 'affiliate_brand')),
    -- No default on purpose: the sync trigger below fills it from `status`
    -- when a legacy writer omits it. BEFORE triggers run before NOT NULL is
    -- checked.
    ADD COLUMN IF NOT EXISTS lifecycle_state TEXT
        CONSTRAINT partner_organizations_lifecycle_state_check
        CHECK (lifecycle_state IN ('draft', 'submitted', 'verifying', 'needs_action', 'exception',
                                   'live', 'paused', 'suspended', 'rejected')),
    ADD COLUMN IF NOT EXISTS legal_name TEXT,
    ADD COLUMN IF NOT EXISTS country TEXT
        CONSTRAINT partner_organizations_country_check CHECK (country ~ '^[A-Z]{2}$'),
    ADD COLUMN IF NOT EXISTS vat_id TEXT,
    ADD COLUMN IF NOT EXISTS website TEXT,
    ADD COLUMN IF NOT EXISTS trust_level SMALLINT NOT NULL DEFAULT 0
        CONSTRAINT partner_organizations_trust_level_check CHECK (trust_level BETWEEN 0 AND 2);

COMMENT ON COLUMN public.partner_organizations.partner_type IS 'VTID-04471: enforced partner vocabulary (lab | supplier_shop | practitioner_clinic | service_provider | affiliate_brand). Replaces free-text org_type in the UI. When set, commerce_vertical is derived from it by trg_partner_organizations_sync (lab, practitioner_clinic -> health; the rest -> general). Nullable for rows registered before VTID-04471.';
COMMENT ON COLUMN public.partner_organizations.lifecycle_state IS 'VTID-04471: onboarding lifecycle (spec §5.2). Allowed transitions are enforced in the gateway (services/partner-lifecycle.ts). Kept in sync with the legacy status column by trg_partner_organizations_sync.';
COMMENT ON COLUMN public.partner_organizations.country IS 'VTID-04471: ISO 3166-1 alpha-2, upper case.';
COMMENT ON COLUMN public.partner_organizations.trust_level IS 'VTID-04471: 0 | 1 | 2, computed by the onboarding engine (spec §7). Never set from a client request.';

-- ===========================================================================
-- 2. Mapping helpers (IMMUTABLE, no table access)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.partner_org_status_for_lifecycle(p_lifecycle TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
    SELECT CASE p_lifecycle
        WHEN 'live'      THEN 'active'
        WHEN 'paused'    THEN 'suspended'
        WHEN 'suspended' THEN 'suspended'
        WHEN 'rejected'  THEN 'rejected'
        ELSE 'pending_review'   -- draft, submitted, verifying, needs_action, exception
    END;
$$;

CREATE OR REPLACE FUNCTION public.partner_org_vertical_for_type(p_partner_type TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
    SELECT CASE
        WHEN p_partner_type IS NULL THEN NULL
        WHEN p_partner_type IN ('lab', 'practitioner_clinic') THEN 'health'
        ELSE 'general'
    END;
$$;

-- ===========================================================================
-- 3. Sync trigger: status <-> lifecycle_state, partner_type -> commerce_vertical
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.partner_organizations_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.lifecycle_state IS NULL THEN
            -- Legacy writer: derive the lifecycle from status.
            NEW.lifecycle_state := CASE NEW.status
                WHEN 'active'    THEN 'live'
                WHEN 'suspended' THEN 'suspended'
                WHEN 'rejected'  THEN 'rejected'
                ELSE 'draft'
            END;
        END IF;
        NEW.status := public.partner_org_status_for_lifecycle(NEW.lifecycle_state);
    ELSE
        IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state THEN
            NEW.status := public.partner_org_status_for_lifecycle(NEW.lifecycle_state);
        ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
            -- Legacy writer changed status only (e.g. POST /:orgId/activate).
            NEW.lifecycle_state := CASE NEW.status
                WHEN 'active'    THEN 'live'
                WHEN 'suspended' THEN 'suspended'
                WHEN 'rejected'  THEN 'rejected'
                ELSE CASE
                    WHEN public.partner_org_status_for_lifecycle(OLD.lifecycle_state) = 'pending_review'
                        THEN OLD.lifecycle_state
                    ELSE 'submitted'
                END
            END;
        END IF;
    END IF;

    IF NEW.partner_type IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.partner_type IS DISTINCT FROM OLD.partner_type
            OR NEW.commerce_vertical IS DISTINCT FROM OLD.commerce_vertical) THEN
        NEW.commerce_vertical := public.partner_org_vertical_for_type(NEW.partner_type);
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_partner_organizations_sync ON public.partner_organizations;
CREATE TRIGGER trg_partner_organizations_sync
    BEFORE INSERT OR UPDATE ON public.partner_organizations
    FOR EACH ROW EXECUTE FUNCTION public.partner_organizations_sync();

-- Existing rows (none live today): derive lifecycle_state from status.
UPDATE public.partner_organizations
   SET lifecycle_state = CASE status
        WHEN 'active'    THEN 'live'
        WHEN 'suspended' THEN 'suspended'
        WHEN 'rejected'  THEN 'rejected'
        ELSE 'draft'
   END
 WHERE lifecycle_state IS NULL;

ALTER TABLE public.partner_organizations ALTER COLUMN lifecycle_state SET NOT NULL;

CREATE INDEX IF NOT EXISTS partner_organizations_lifecycle_idx ON public.partner_organizations (lifecycle_state);

-- ===========================================================================
-- 4. merchants -> partner_organizations
-- ===========================================================================

ALTER TABLE public.merchants
    ADD COLUMN IF NOT EXISTS partner_organization_id UUID
        REFERENCES public.partner_organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS merchants_partner_organization_idx ON public.merchants (partner_organization_id);
COMMENT ON COLUMN public.merchants.partner_organization_id IS 'VTID-04471: the partner organization that owns this merchant (spec §5.1). Nullable: network-sourced merchants (Awin, Admitad, CJ ...) have no self-service owner.';

-- ===========================================================================
-- 5. Backfill: every owned merchant without an org gets a one-member org.
--    Idempotent (only merchants whose partner_organization_id IS NULL), one
--    org per owner so a second merchant of the same owner joins the first.
-- ===========================================================================

DO $$
DECLARE
    r RECORD;
    v_org_id UUID;
BEGIN
    FOR r IN
        SELECT m.owner_user_id, min(m.name) AS name, array_agg(m.id) AS merchant_ids
          FROM public.merchants m
         WHERE m.owner_user_id IS NOT NULL
           AND m.partner_organization_id IS NULL
         GROUP BY m.owner_user_id
    LOOP
        SELECT o.id INTO v_org_id
          FROM public.partner_organizations o
         WHERE o.owner_user_id = r.owner_user_id
         ORDER BY o.created_at
         LIMIT 1;

        IF v_org_id IS NULL THEN
            INSERT INTO public.partner_organizations
                (org_key, display_name, org_type, partner_type, lifecycle_state, owner_user_id, business_details)
            VALUES
                ('merchant-' || replace(r.owner_user_id::text, '-', ''), r.name, 'supplier', 'supplier_shop', 'draft',
                 r.owner_user_id, jsonb_build_object('backfilled_by', 'VTID-04471'))
            ON CONFLICT (org_key) DO NOTHING
            RETURNING id INTO v_org_id;

            IF v_org_id IS NULL THEN
                SELECT id INTO v_org_id FROM public.partner_organizations
                 WHERE org_key = 'merchant-' || replace(r.owner_user_id::text, '-', '');
            END IF;

            INSERT INTO public.partner_organization_members (partner_organization_id, user_id, role, granted_by)
            VALUES (v_org_id, r.owner_user_id, 'org_admin', r.owner_user_id)
            ON CONFLICT (partner_organization_id, user_id) DO NOTHING;
        END IF;

        UPDATE public.merchants SET partner_organization_id = v_org_id
         WHERE id = ANY (r.merchant_ids);
    END LOOP;
END;
$$;
