-- VTID-05324 (mt-launch/pack-intake-db, P1): tenant pack intake checklist.
--
-- One row per (tenant, WS8 intake item): what a launching tenant still owes
-- (anchor-person consent, brand kit, Season 0 approval, calendar, seed groups,
-- founding invites, revenue share, health-claims sign-off, ...). Read and
-- written only by the gateway (service role); tenant scoping is enforced by the
-- gateway admin endpoints (pack-intake-admin), never by client access.
--
-- Expand-only: one new table, no backfill, no change to an existing object.
-- Service-role-only RLS, mirroring public.product_analytics_events
-- (20260612140000_BOOTSTRAP_product_analytics_events.sql). Client roles also
-- lose every table privilege, so a non-service-role read fails outright.
-- The live tenants key is tenants(tenant_id) (see VTID-04716).
--
-- Rollback: docs/validation/VTID-05324/rollback-pack-intake.sql
-- Order: docs/multitenancy/MIGRATION-QUEUE.md (after WS5 tenant_content_overrides).

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'tenant_id'
  ) THEN
    RAISE EXCEPTION 'VTID-05324: public.tenants(tenant_id) is missing; refusing to create tenant_pack_intake';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.tenant_pack_intake (
  tenant_id   uuid        NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
  item_key    text        NOT NULL,
  status      text        NOT NULL DEFAULT 'not_started',
  evidence    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  decided_by  uuid        NULL,
  decided_at  timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_pack_intake_pkey PRIMARY KEY (tenant_id, item_key),
  CONSTRAINT tenant_pack_intake_item_key_check CHECK (item_key IN (
    'anchor_person_consent',
    'brand_kit',
    'copy',
    'persona_facts',
    'brand_kb_docs',
    'season0_approval',
    'events_calendar_90d',
    'seed_groups',
    'host_moderator_support_sla',
    'founding_invites_30',
    'revenue_share',
    'locales',
    'health_claims_signoff'
  )),
  CONSTRAINT tenant_pack_intake_status_check CHECK (status IN (
    'not_started',
    'in_progress',
    'blocked',
    'approved'
  ))
);

COMMENT ON TABLE public.tenant_pack_intake IS
  'VTID-05324: WS8 tenant pack intake checklist, one row per (tenant_id, item_key). Service role only.';

ALTER TABLE public.tenant_pack_intake ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.tenant_pack_intake FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenant_pack_intake TO service_role;

DROP POLICY IF EXISTS "service role can manage tenant pack intake" ON public.tenant_pack_intake;
CREATE POLICY "service role can manage tenant pack intake"
  ON public.tenant_pack_intake
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

COMMIT;
