-- VTID-05488 (mt-discover-r2/supplier-relationships-db) D1: public.supplier_tenant_relationships.
--
-- One row per (merchant/supplier, tenant): whether that supplier's offerings are part of the tenant's Discover.
-- Status flow: proposed -> active | declined, active <-> suspended (the flow is enforced by the gateway, the DB only
-- guarantees the vocabulary). Referenced by, not duplicated from, the merchant (merchants.id) and the partner
-- organization (partner_organizations.id, nullable, FK only when that table exists).
--
-- RLS: tenant members read their own tenant's rows through an inline EXISTS on public.user_tenants and auth.uid()
-- (no mt-identity-r2 helper: none exists in the migrations today); service_role has ALL; anon and
-- authenticated have no write privilege at all.
--
-- Seed (expand only): every merchant that exists today gets an `active` row for the tenant slug 'maxina' and for no
-- other tenant, so the gate-on catalogue of Maxina equals today's. No existing row is changed or removed.
--
-- Safe to re-run (IF NOT EXISTS / ON CONFLICT DO NOTHING). lock_timeout 3s with up to 5 retries on lock_not_available.
-- Rollback: docs/validation/VTID-05488/rollback-120000-supplier-tenant-relationships.sql
-- Order: docs/multitenancy/MIGRATION-QUEUE.md (row 26).

BEGIN;

DO $mig$
DECLARE
  v_try   int := 0;
  v_key   text;
BEGIN
  IF to_regclass('public.merchants') IS NULL THEN
    RAISE EXCEPTION 'VTID-05488: public.merchants is missing; refusing to create supplier_tenant_relationships';
  END IF;
  IF to_regclass('public.user_tenants') IS NULL THEN
    RAISE EXCEPTION 'VTID-05488: public.user_tenants is missing; refusing to create supplier_tenant_relationships';
  END IF;

  -- The live tenants key is tenants(tenant_id) (VTID-04716); a fresh local stack built from the bootstrap has tenants(id).
  SELECT c.column_name INTO v_key
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'tenants' AND c.column_name IN ('tenant_id', 'id')
   ORDER BY (c.column_name = 'tenant_id') DESC
   LIMIT 1;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'VTID-05488: public.tenants has neither tenant_id nor id; refusing to create supplier_tenant_relationships';
  END IF;

  LOOP
    v_try := v_try + 1;
    BEGIN
      SET LOCAL lock_timeout = '3s';

      CREATE TABLE IF NOT EXISTS public.supplier_tenant_relationships (
        id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        merchant_id              uuid        NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
        partner_organization_id  uuid        NULL,
        tenant_id                uuid        NOT NULL,
        status                   text        NOT NULL DEFAULT 'proposed',
        vertical_key             text        NULL,
        created_at               timestamptz NOT NULL DEFAULT now(),
        updated_at               timestamptz NOT NULL DEFAULT now(),
        decided_at               timestamptz NULL,
        CONSTRAINT supplier_tenant_relationships_status_check
          CHECK (status IN ('proposed', 'active', 'declined', 'suspended'))
      );

      -- The tenants key column differs between the live schema and the bootstrap, so the FK is added dynamically.
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conname = 'supplier_tenant_relationships_tenant_fkey'
                        AND conrelid = 'public.supplier_tenant_relationships'::regclass) THEN
        EXECUTE format('ALTER TABLE public.supplier_tenant_relationships '
                       'ADD CONSTRAINT supplier_tenant_relationships_tenant_fkey '
                       'FOREIGN KEY (tenant_id) REFERENCES public.tenants(%I) ON DELETE CASCADE', v_key);
      END IF;

      -- One relationship per supplier, tenant and vertical (NULL vertical = the whole supplier).
      CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_tenant_relationships_scope
        ON public.supplier_tenant_relationships (merchant_id, tenant_id, coalesce(vertical_key, ''));
      CREATE INDEX IF NOT EXISTS idx_supplier_tenant_relationships_tenant_status
        ON public.supplier_tenant_relationships (tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_supplier_tenant_relationships_merchant
        ON public.supplier_tenant_relationships (merchant_id) WHERE status = 'active';

      IF to_regclass('public.partner_organizations') IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM pg_constraint
                          WHERE conname = 'supplier_tenant_relationships_partner_org_fkey'
                            AND conrelid = 'public.supplier_tenant_relationships'::regclass) THEN
        ALTER TABLE public.supplier_tenant_relationships
          ADD CONSTRAINT supplier_tenant_relationships_partner_org_fkey
          FOREIGN KEY (partner_organization_id) REFERENCES public.partner_organizations(id) ON DELETE SET NULL;
      END IF;

      ALTER TABLE public.supplier_tenant_relationships ENABLE ROW LEVEL SECURITY;

      REVOKE ALL ON TABLE public.supplier_tenant_relationships FROM PUBLIC, anon, authenticated;
      GRANT SELECT ON TABLE public.supplier_tenant_relationships TO authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.supplier_tenant_relationships TO service_role;

      DROP POLICY IF EXISTS supplier_tenant_relationships_member_select ON public.supplier_tenant_relationships;
      CREATE POLICY supplier_tenant_relationships_member_select
        ON public.supplier_tenant_relationships
        FOR SELECT TO authenticated
        USING (EXISTS (SELECT 1 FROM public.user_tenants ut
                        WHERE ut.tenant_id = supplier_tenant_relationships.tenant_id
                          AND ut.user_id = auth.uid()));

      DROP POLICY IF EXISTS supplier_tenant_relationships_service ON public.supplier_tenant_relationships;
      CREATE POLICY supplier_tenant_relationships_service
        ON public.supplier_tenant_relationships
        FOR ALL TO service_role
        USING (true) WITH CHECK (true);

      COMMENT ON TABLE public.supplier_tenant_relationships IS
        'VTID-05488: which tenants (communities) a supplier/merchant is part of. status proposed|active|declined|suspended. Members of the tenant read; service_role writes.';

      -- D7 seed: every merchant that exists today is active for Maxina only. Expand only, idempotent.
      EXECUTE format($s$
        INSERT INTO public.supplier_tenant_relationships (merchant_id, tenant_id, status, decided_at)
        SELECT m.id, t.%1$I, 'active', now()
          FROM public.merchants m
          CROSS JOIN public.tenants t
         WHERE t.slug = 'maxina'
        ON CONFLICT DO NOTHING$s$, v_key);

      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF v_try >= 5 THEN RAISE; END IF;
      RAISE NOTICE 'VTID-05488 D1: lock timeout, retry % of 5', v_try;
      PERFORM pg_sleep(v_try);
    END;
  END LOOP;
END
$mig$;

COMMIT;
