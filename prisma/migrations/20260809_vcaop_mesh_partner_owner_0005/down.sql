-- DOWN / rollback for 20260809_vcaop_mesh_partner_owner_0005 (VTID-03553).
DROP INDEX IF EXISTS "idx_partner_tenant_owner";
ALTER TABLE "partner_tenant" DROP COLUMN IF EXISTS "owner_email";
ALTER TABLE "partner_tenant" DROP COLUMN IF EXISTS "owner_user_id";
