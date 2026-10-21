-- DOWN / rollback for 20260924_vcaop_partner_org_link_0007 (VTID-04471).
-- Backfilled orgs are left in place (they are real org rows with a member);
-- only the link column goes.
DROP INDEX IF EXISTS "idx_partner_tenant_partner_org";
ALTER TABLE "partner_tenant" DROP CONSTRAINT IF EXISTS "partner_tenant_partner_organization_id_fkey";
ALTER TABLE "partner_tenant" DROP COLUMN IF EXISTS "partner_organization_id";
