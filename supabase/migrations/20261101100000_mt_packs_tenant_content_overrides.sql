-- VTID-05495 (mt-packs-r2/content-overrides-db): WS5 tenant content overrides.
--
-- One row per (tenant, locale, key): the text a tenant's content pack publishes over the platform default for that
-- locale. It is the publish target that mt-launch (pack intake, VTID-05324) depends on. This migration creates the
-- table only: no reader and no writer in this change, no backfill, no change to an existing object.
--
-- Service-role-only, the same pattern as the mt-launch tables (20261101110000_mt_launch_tenant_pack_intake.sql):
-- RLS on, a service_role policy, and every client privilege revoked, so an anon/authenticated read fails outright.
-- Tenant scoping is the gateway's job (it resolves the tenant, then uses the service role).
-- The live tenants key is tenants(tenant_id) (VTID-04716); the plan text says tenants(id), the live schema wins.
--
-- Expand-only and idempotent (IF NOT EXISTS, DROP POLICY IF EXISTS), safe to run twice.
-- Version 20261101100000 sorts before mt-launch's 20261101110000.
-- Rollback: docs/validation/VTID-05495/rollback.sql (DROP TABLE).
-- Order: docs/multitenancy/MIGRATION-QUEUE.md (the row directly before the mt-launch rows).

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'tenant_id'
  ) THEN
    RAISE EXCEPTION 'VTID-05495: public.tenants(tenant_id) is missing; refusing to create tenant_content_overrides';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.tenant_content_overrides (
  tenant_id   uuid        NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
  locale      text        NOT NULL,
  key         text        NOT NULL,
  value       text        NOT NULL,
  updated_by  uuid        NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_content_overrides_pkey PRIMARY KEY (tenant_id, locale, key),
  CONSTRAINT tenant_content_overrides_locale_check CHECK (locale ~ '^[a-z]{2}(-[A-Z]{2})?$')
);

COMMENT ON TABLE public.tenant_content_overrides IS
  'VTID-05495: WS5 per-tenant content-pack text overrides, one row per (tenant_id, locale, key). Service role only.';

ALTER TABLE public.tenant_content_overrides ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.tenant_content_overrides FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.tenant_content_overrides TO service_role;

DROP POLICY IF EXISTS "service role can manage tenant content overrides" ON public.tenant_content_overrides;
CREATE POLICY "service role can manage tenant content overrides"
  ON public.tenant_content_overrides
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

COMMIT;
