-- VTID-05507 (mt-m3-r2/tenant-domains-db) D1: public.tenant_domains.
--
-- One row per custom host (for example community.example.org) that points at a tenant. The host arm of
-- resolve_tenant(p_host, p_slug) (20261102140100) reads it; nothing else does yet. Dark: no code reads this table
-- until the gateway lane host-resolution-gw ships behind MT_RESOLUTION_V2.
--
-- Shape: tenant_domains(id, tenant_id -> tenants, host, is_primary, verified_at, created_at).
--   * host is stored lower-case and trimmed (CHECK host = lower(btrim(host))), unique, and must look like a DNS name
--     (CHECK on the format, 1..253 chars). It is plain text with that CHECK instead of citext: no migration in this
--     repository creates the citext extension, so the lane does not depend on it.
--   * A host that equals a reserved tenant slug ('admin', 'api', ...) is rejected by a BEFORE INSERT OR UPDATE OF host
--     trigger that reads reserved_tenant_slugs. A CHECK cannot read another table.
--   * At most one primary host per tenant (partial unique index).
--   * RLS is enabled and there is NO client policy: anon and authenticated have no privilege at all. The admin API
--     reaches the table with the service role. The public read path is the SECURITY DEFINER resolve_tenant overload.
--
-- Expand only (one new table, one trigger function). Safe to re-run. lock_timeout 3s with up to 5 retries.
-- Rollback: docs/validation/VTID-05507/rollback-140000-tenant-domains.sql
-- Order: docs/multitenancy/MIGRATION-QUEUE.md (mt-m3-r2 rows).

-- impact-allow-solo-migration: expand only (one new table + trigger). The gateway host arm (host-resolution-gw) is a
-- separate lane, dark behind MT_RESOLUTION_V2; nothing reads tenant_domains before it ships.

BEGIN;

DO $mig$
DECLARE
  v_try int := 0;
  v_key text;
BEGIN
  IF to_regclass('public.tenants') IS NULL THEN
    RAISE EXCEPTION 'VTID-05507: public.tenants is missing; refusing to create tenant_domains';
  END IF;
  IF to_regclass('public.reserved_tenant_slugs') IS NULL THEN
    RAISE EXCEPTION 'VTID-05507: public.reserved_tenant_slugs is missing (VTID-05150); refusing to create tenant_domains';
  END IF;

  -- The live tenants key is tenants(tenant_id) (VTID-04716); a fresh local stack built from the bootstrap has tenants(id).
  SELECT c.column_name INTO v_key
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'tenants' AND c.column_name IN ('tenant_id', 'id')
   ORDER BY (c.column_name = 'tenant_id') DESC
   LIMIT 1;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'VTID-05507: public.tenants has neither tenant_id nor id; refusing to create tenant_domains';
  END IF;

  LOOP
    v_try := v_try + 1;
    BEGIN
      SET LOCAL lock_timeout = '3s';

      CREATE TABLE IF NOT EXISTS public.tenant_domains (
        id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid        NOT NULL,
        host        text        NOT NULL,
        is_primary  boolean     NOT NULL DEFAULT false,
        verified_at timestamptz NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT tenant_domains_host_unique UNIQUE (host),
        CONSTRAINT tenant_domains_host_normalized_check CHECK (host = lower(btrim(host))),
        CONSTRAINT tenant_domains_host_format_check CHECK (
          char_length(host) BETWEEN 1 AND 253
          AND host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
        )
      );

      -- The tenants key column differs between the live schema and the bootstrap, so the FK is added dynamically.
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conname = 'tenant_domains_tenant_fkey'
                        AND conrelid = 'public.tenant_domains'::regclass) THEN
        EXECUTE format('ALTER TABLE public.tenant_domains '
                       'ADD CONSTRAINT tenant_domains_tenant_fkey '
                       'FOREIGN KEY (tenant_id) REFERENCES public.tenants(%I) ON DELETE CASCADE', v_key);
      END IF;

      CREATE INDEX IF NOT EXISTS idx_tenant_domains_tenant ON public.tenant_domains (tenant_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_domains_one_primary
        ON public.tenant_domains (tenant_id) WHERE is_primary;

      ALTER TABLE public.tenant_domains ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON TABLE public.tenant_domains FROM PUBLIC, anon, authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenant_domains TO service_role;
      -- No policy for anon or authenticated: they hold no privilege either. service_role bypasses RLS.

      COMMENT ON TABLE public.tenant_domains IS
        'VTID-05507: custom hosts that point at a tenant. Service role only (no client policy). A host resolves only when verified_at IS NOT NULL (resolve_tenant(p_host, p_slug)).';

      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF v_try >= 5 THEN RAISE; END IF;
      RAISE NOTICE 'VTID-05507 D1: lock timeout, retry % of 5', v_try;
      PERFORM pg_sleep(v_try);
    END;
  END LOOP;
END
$mig$;

-- Reserved-slug guard. Not SECURITY DEFINER: it runs as the writer, and only the service role can write the table.
CREATE OR REPLACE FUNCTION public.tenant_domains_reject_reserved()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM public.reserved_tenant_slugs r WHERE r.slug = lower(btrim(NEW.host))) THEN
    RAISE EXCEPTION 'tenant_domains: host % is a reserved slug', NEW.host
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.tenant_domains_reject_reserved() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tenant_domains_reject_reserved ON public.tenant_domains;
CREATE TRIGGER tenant_domains_reject_reserved
  BEFORE INSERT OR UPDATE OF host
  ON public.tenant_domains
  FOR EACH ROW EXECUTE FUNCTION public.tenant_domains_reject_reserved();

-- End state, asserted by effect.
DO $$
BEGIN
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.tenant_domains'::regclass) THEN
    RAISE EXCEPTION 'VTID-05507: RLS is not enabled on tenant_domains';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tenant_domains') THEN
    RAISE EXCEPTION 'VTID-05507: tenant_domains must have no client policy';
  END IF;
  IF has_table_privilege('anon', 'public.tenant_domains', 'SELECT')
     OR has_table_privilege('authenticated', 'public.tenant_domains', 'SELECT') THEN
    RAISE EXCEPTION 'VTID-05507: a client role can read tenant_domains';
  END IF;
END $$;

COMMIT;
