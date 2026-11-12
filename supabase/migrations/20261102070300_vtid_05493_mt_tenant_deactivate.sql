-- VTID-05493 (mt-tenant-admin-r2 / tenant-lifecycle-db, L1): deactivate_tenant(slug).
--
-- Sets tenants.is_active = false for one tenant, idempotently. Nothing else is touched: memberships, user_tenants,
-- tenant_settings and all tenant content stay as they are, so a deactivation is reversible by the rollback below.
-- Members of a deactivated tenant are not locked out: the closing switch change in 20261102070350 resolves them to the
-- default tenant.
--
-- Guards (SQLSTATE 22023, stable code word as the message): INVALID_SLUG (NULL/blank), TENANT_NOT_FOUND,
-- DEFAULT_TENANT_PROTECTED (tenants.is_default: the fallback for everyone), PLATFORM_TENANT_PROTECTED (tenants.is_platform).
-- Returns jsonb {tenant_id, slug, changed}; changed is false on a repeat call.
-- EXECUTE: service_role only. The gateway route (lane tenant-admin-api) gates the caller to exafy-admin; members and
-- anon can never call this.
--
-- Snapshot before any data move: public.bak_vtid_05493_tenant_lifecycle records (tenant_id, is_active) of every tenant
-- as it was at apply time. The rollback restores is_active from it. The table is closed to authenticated and anon.
--
-- Depends on: 20261014000100 (VTID-05149: tenants.is_default / is_platform). The guard refuses without it.
-- Rollback: docs/validation/VTID-05493/rollback-070300-tenant-deactivate.sql.
-- Apply: owner approval of the file and the target database first (collaboration.md section 7d); one RUN-MIGRATION dispatch.

-- impact-allow-solo-migration: lands dark; the gateway routes that call it ship in the tenant-admin-api lane, merged only
-- after this is applied, and stay behind MT_RESOLUTION_V2.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'tenants'
         AND column_name IN ('tenant_id', 'slug', 'is_active', 'is_default', 'is_platform')) <> 5 THEN
    RAISE EXCEPTION 'VTID-05493: tenants.tenant_id/slug/is_active/is_default/is_platform missing - apply 20261014000100 (VTID-05149) first';
  END IF;
END
$guard$;

-- Snapshot (read-only copy of the state this migration can change).
CREATE TABLE IF NOT EXISTS public.bak_vtid_05493_tenant_lifecycle AS
  SELECT t.tenant_id, t.is_active, now() AS captured_at FROM public.tenants t;
ALTER TABLE public.bak_vtid_05493_tenant_lifecycle ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bak_vtid_05493_tenant_lifecycle FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.bak_vtid_05493_tenant_lifecycle TO service_role;
COMMENT ON TABLE public.bak_vtid_05493_tenant_lifecycle IS
  'VTID-05493: tenants.is_active as it was before deactivate_tenant()/archive_tenant() existed. Used by the rollback only.';

CREATE OR REPLACE FUNCTION public.deactivate_tenant(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_t    record;
  v_rows int;
BEGIN
  IF v_slug = '' THEN
    RAISE EXCEPTION 'INVALID_SLUG' USING ERRCODE = '22023';
  END IF;

  SELECT t.tenant_id, t.slug, t.is_default, t.is_platform INTO v_t
    FROM public.tenants t WHERE t.slug = v_slug FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TENANT_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF v_t.is_default THEN
    RAISE EXCEPTION 'DEFAULT_TENANT_PROTECTED' USING ERRCODE = '22023';
  END IF;
  IF v_t.is_platform THEN
    RAISE EXCEPTION 'PLATFORM_TENANT_PROTECTED' USING ERRCODE = '22023';
  END IF;

  UPDATE public.tenants SET is_active = false WHERE tenant_id = v_t.tenant_id AND is_active;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  RETURN jsonb_build_object('tenant_id', v_t.tenant_id, 'slug', v_t.slug, 'changed', v_rows > 0);
END;
$fn$;

COMMENT ON FUNCTION public.deactivate_tenant(text) IS
  'VTID-05493: sets tenants.is_active=false (idempotent). Refuses the default and platform tenants. service_role only.';
REVOKE ALL ON FUNCTION public.deactivate_tenant(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deactivate_tenant(text) TO service_role;

COMMIT;
