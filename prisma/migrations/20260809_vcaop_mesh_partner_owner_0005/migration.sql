-- Commerce Mesh — merchant self-service ownership (VTID-03553).
-- A partner_tenant row now records WHICH USER owns the business connection,
-- so the self-service portal (commerce.vitanaland.com) can scope reads and
-- writes to the owner. Additive; applied to Supabase 2026-08-09.
ALTER TABLE "partner_tenant" ADD COLUMN IF NOT EXISTS "owner_user_id" TEXT;
ALTER TABLE "partner_tenant" ADD COLUMN IF NOT EXISTS "owner_email" TEXT;
CREATE INDEX IF NOT EXISTS "idx_partner_tenant_owner" ON "partner_tenant"("owner_user_id");
