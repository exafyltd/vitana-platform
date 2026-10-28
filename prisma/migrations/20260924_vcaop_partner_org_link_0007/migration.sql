-- Commerce Mesh: link a VCAOP connection to its partner organization
-- (VTID-04471, docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md §5.1).
-- Every partner_tenant belongs to an org. Nullable so the column can be added
-- before every writer sets it.
--
-- Depends on supabase/migrations/20260924130000_vtid_04471_partner_account_model.sql
-- (apply that first): partner_organizations is Supabase-managed, this table is
-- Prisma-managed, and the FK crosses the two.
--
-- Live state 2026-09-24: 0 partner_tenant rows, so the backfill below does
-- nothing today. It is idempotent: only rows with an owner and no org, only
-- owners whose id is a uuid (owner_user_id is TEXT here).
ALTER TABLE "partner_tenant" ADD COLUMN IF NOT EXISTS "partner_organization_id" UUID;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_tenant_partner_organization_id_fkey') THEN
        ALTER TABLE "partner_tenant"
            ADD CONSTRAINT "partner_tenant_partner_organization_id_fkey"
            FOREIGN KEY ("partner_organization_id") REFERENCES "partner_organizations"("id") ON DELETE SET NULL;
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS "idx_partner_tenant_partner_org" ON "partner_tenant"("partner_organization_id");

DO $$
DECLARE
    r RECORD;
    v_owner UUID;
    v_org_id UUID;
BEGIN
    FOR r IN
        SELECT t."owner_user_id", min(t."name") AS name, array_agg(t."id") AS tenant_ids
          FROM "partner_tenant" t
         WHERE t."partner_organization_id" IS NULL
           AND t."owner_user_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         GROUP BY t."owner_user_id"
    LOOP
        v_owner := r."owner_user_id"::uuid;

        SELECT o.id INTO v_org_id FROM "partner_organizations" o
         WHERE o.owner_user_id = v_owner ORDER BY o.created_at LIMIT 1;

        IF v_org_id IS NULL THEN
            INSERT INTO "partner_organizations"
                (org_key, display_name, org_type, lifecycle_state, owner_user_id, business_details)
            VALUES ('connection-' || replace(v_owner::text, '-', ''), r.name, 'connection', 'draft', v_owner,
                    jsonb_build_object('backfilled_by', 'VTID-04471'))
            ON CONFLICT (org_key) DO NOTHING
            RETURNING id INTO v_org_id;

            IF v_org_id IS NULL THEN
                SELECT id INTO v_org_id FROM "partner_organizations"
                 WHERE org_key = 'connection-' || replace(v_owner::text, '-', '');
            END IF;

            INSERT INTO "partner_organization_members" (partner_organization_id, user_id, role, granted_by)
            VALUES (v_org_id, v_owner, 'org_admin', v_owner)
            ON CONFLICT (partner_organization_id, user_id) DO NOTHING;
        END IF;

        UPDATE "partner_tenant" SET "partner_organization_id" = v_org_id WHERE "id" = ANY (r.tenant_ids);
    END LOOP;
END;
$$;
