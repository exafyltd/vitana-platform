-- VTID-05488 (mt-discover-r2/supplier-relationships-db) D3: partner_tenant.tenant_id free text -> real tenant UUID or NULL.
--
-- partner_tenant is Prisma-managed (prisma/migrations/20260808_vcaop_mesh_factory_0001): tenant_id is TEXT NOT NULL and
-- is written and filtered as free text (a partner key, a slug, sometimes a uuid string) by the VCAOP gateway code
-- (vcaop-portal-repository.ts: .eq('partner_tenant.tenant_id', ...), insert/lookup by text). Changing that column's type
-- in place would break every one of those writers and readers at apply time, so this migration is EXPAND ONLY:
--
--   1. snapshot public.partner_tenant into public.bak_vtid_05488_partner_tenant FIRST (never overwritten on re-run);
--   2. add partner_tenant.tenant_uuid uuid NULL REFERENCES tenants (ON DELETE SET NULL);
--   3. map ONLY unambiguous rows: the text is the uuid of exactly one tenant, or equals (case-insensitive) the slug of
--      exactly one tenant, and the two readings do not name different tenants. Everything else stays NULL
--      (NULL = platform / unresolved). An already-mapped row is never changed.
--
-- The text column is left untouched; dropping it (contract) is a later, separately approved step once the writers read
-- tenant_uuid. The table may not exist on a database where Prisma never ran: then this migration only logs a NOTICE.
--
-- Safe to re-run. lock_timeout 3s with up to 5 retries on lock_not_available.
-- Rollback: docs/validation/VTID-05488/rollback-120200-partner-tenant-backfill.sql
-- Order: docs/multitenancy/MIGRATION-QUEUE.md (row 28).

BEGIN;

DO $mig$
DECLARE
  v_try     int := 0;
  v_key     text;
  v_mapped  bigint;
  v_total   bigint;
BEGIN
  IF to_regclass('public.partner_tenant') IS NULL THEN
    RAISE NOTICE 'VTID-05488 D3: public.partner_tenant does not exist; nothing to backfill';
    RETURN;
  END IF;
  IF to_regclass('public.tenants') IS NULL THEN
    RAISE EXCEPTION 'VTID-05488 D3: public.tenants is missing; refusing to backfill partner_tenant';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'partner_tenant'
                    AND column_name = 'tenant_id' AND data_type = 'text') THEN
    RAISE EXCEPTION 'VTID-05488 D3: partner_tenant.tenant_id is not text; expected the Prisma free-text column';
  END IF;

  SELECT c.column_name INTO v_key
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'tenants' AND c.column_name IN ('tenant_id', 'id')
   ORDER BY (c.column_name = 'tenant_id') DESC
   LIMIT 1;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'VTID-05488 D3: public.tenants has neither tenant_id nor id';
  END IF;

  LOOP
    v_try := v_try + 1;
    BEGIN
      SET LOCAL lock_timeout = '3s';

      -- 1. Snapshot first. IF NOT EXISTS: a second run keeps the original snapshot.
      CREATE TABLE IF NOT EXISTS public.bak_vtid_05488_partner_tenant AS
        SELECT now() AS snapshot_at, p.* FROM public.partner_tenant p;
      ALTER TABLE public.bak_vtid_05488_partner_tenant ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON TABLE public.bak_vtid_05488_partner_tenant FROM PUBLIC, anon, authenticated;
      GRANT SELECT ON TABLE public.bak_vtid_05488_partner_tenant TO service_role;

      -- 2. Expand.
      EXECUTE format($t$
        ALTER TABLE public.partner_tenant
          ADD COLUMN IF NOT EXISTS tenant_uuid uuid NULL REFERENCES public.tenants(%I) ON DELETE SET NULL$t$, v_key);
      CREATE INDEX IF NOT EXISTS idx_partner_tenant_tenant_uuid
        ON public.partner_tenant (tenant_uuid) WHERE tenant_uuid IS NOT NULL;
      COMMENT ON COLUMN public.partner_tenant.tenant_uuid IS
        'VTID-05488: real tenants key resolved from the free-text tenant_id (uuid string or slug), NULL = platform / unresolved. tenant_id text stays until the writers move.';

      -- 3. Map only unambiguous rows. A candidate is the tenant whose key equals the text (when the text is a uuid)
      --    or whose slug equals the text. Exactly one distinct candidate -> map; zero or 2+ -> leave NULL.
      EXECUTE format($m$
        WITH cand AS (
          SELECT p.id AS pid, t.%1$I AS tkey
            FROM public.partner_tenant p
            JOIN public.tenants t
              ON (p.tenant_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  AND t.%1$I::text = lower(p.tenant_id))
              OR lower(t.slug) = lower(btrim(p.tenant_id))
           WHERE p.tenant_uuid IS NULL
        ), uniq AS (
          SELECT pid, (array_agg(DISTINCT tkey::text))[1]::uuid AS tkey
            FROM cand GROUP BY pid HAVING count(DISTINCT tkey) = 1
        )
        UPDATE public.partner_tenant p
           SET tenant_uuid = u.tkey
          FROM uniq u
         WHERE p.id = u.pid AND p.tenant_uuid IS NULL$m$, v_key);

      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF v_try >= 5 THEN RAISE; END IF;
      RAISE NOTICE 'VTID-05488 D3: lock timeout, retry % of 5', v_try;
      PERFORM pg_sleep(v_try);
    END;
  END LOOP;

  SELECT count(*), count(*) FILTER (WHERE tenant_uuid IS NOT NULL) INTO v_total, v_mapped FROM public.partner_tenant;
  RAISE NOTICE 'VTID-05488 D3: partner_tenant rows %, mapped to a tenant %, left NULL %', v_total, v_mapped, v_total - v_mapped;
END
$mig$;

COMMIT;
