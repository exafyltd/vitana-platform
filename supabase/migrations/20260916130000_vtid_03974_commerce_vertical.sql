-- Purpose: VTID-03974 Commerce Partner Onboarding (Phase B) — close the
--          partner_organizations <-> partner_registry gap. A self-
--          registered org has no way today to ever receive a health order:
--          partner_health_test_orders.partner_id references
--          partner_registry, not partner_organizations, and nothing writes
--          a partner_registry row for a newly self-registered org.
-- Date: 2026-09-16
--
-- This migration adds ONLY the machine-readable routing signal
-- (commerce_vertical) that decides whether an org needs a partner_registry
-- bridge at all. The bridge itself (find-or-create partner_registry on
-- activation) is application code in partner-orgs.ts, not a migration
-- concern — see the VTID-03974 changelog entry in CLAUDE.md.
--
-- Deliberately NOT `org_type` (free-text by design, no enforced
-- vocabulary — see partner_organizations.org_type's own comment in
-- 20260915120000_vtid_03932_partner_organizations.sql). A machine-readable
-- routing decision needs an enforced value, not a string match against
-- free text a registrant could spell any way at all.

ALTER TABLE public.partner_organizations
    ADD COLUMN IF NOT EXISTS commerce_vertical TEXT
        CHECK (commerce_vertical IN ('health', 'general'));

COMMENT ON COLUMN public.partner_organizations.commerce_vertical IS 'VTID-03974: machine-readable routing signal, set explicitly at registration (never inferred from org_type). ''health'' orgs get a partner_registry bridge on activation (see partner-orgs.ts POST /:orgId/activate); ''general'' orgs use the existing merchants/products catalog path unchanged. Nullable for rows registered before this migration.';
