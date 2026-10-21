-- VTID-05324 (mt-launch/pack-intake-db, P2 + P3): tenant content pipeline +
-- read-only launch readiness.
--
-- P2 public.tenant_content_pipeline: one row per (tenant, locale, key) of
--    AI-generated tenant content (candidate from a Maxina template, lint
--    report, review/sign-off state). The publish target
--    tenant_content_overrides is WS5's (mt-packs); nothing here writes to it.
--    Service-role-only RLS, mirroring public.product_analytics_events;
--    client roles lose every table privilege.
-- P3 public.get_tenant_launch_readiness(p_tenant_id): intake completeness for
--    the owner-analytics + readiness surfaces. Reads ONLY
--    public.tenant_pack_intake and public.tenants (never a health table).
--    SECURITY INVOKER (the only caller is the gateway service role, which
--    already reads both tables), STABLE, search_path pinned, EXECUTE for
--    service_role only. Returns NULL for an unknown tenant.
--
-- Expand-only: one new table + one new function, no backfill.
-- Depends on 20261101110000_mt_launch_tenant_pack_intake.sql.
-- Rollback: docs/validation/VTID-05324/rollback-pack-intake.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.tenant_pack_intake') IS NULL THEN
    RAISE EXCEPTION 'VTID-05324: apply 20261101110000_mt_launch_tenant_pack_intake.sql first';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.tenant_content_pipeline (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
  locale           text        NOT NULL,
  key              text        NOT NULL,
  source_template  text        NULL,
  candidate_value  text        NULL,
  lint_report      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  review_state     text        NOT NULL DEFAULT 'generated',
  reviewed_by      uuid        NULL,
  signed_off_by    uuid        NULL,
  published_at     timestamptz NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_content_pipeline_pkey PRIMARY KEY (id),
  CONSTRAINT tenant_content_pipeline_tenant_locale_key_unique UNIQUE (tenant_id, locale, key),
  CONSTRAINT tenant_content_pipeline_review_state_check CHECK (review_state IN (
    'generated',
    'linted',
    'in_review',
    'signed_off',
    'published',
    'rejected'
  ))
);

COMMENT ON TABLE public.tenant_content_pipeline IS
  'VTID-05324: WS8 AI-assisted tenant content pipeline, one row per (tenant_id, locale, key). Service role only.';

ALTER TABLE public.tenant_content_pipeline ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.tenant_content_pipeline FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenant_content_pipeline TO service_role;

DROP POLICY IF EXISTS "service role can manage tenant content pipeline" ON public.tenant_content_pipeline;
CREATE POLICY "service role can manage tenant content pipeline"
  ON public.tenant_content_pipeline
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- The checklist below must equal tenant_pack_intake_item_key_check
-- (20261101110000); services/gateway/test/mt-launch-pack-intake-pgtap.test.ts pins it.
CREATE OR REPLACE FUNCTION public.get_tenant_launch_readiness(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $fn$
  WITH checklist(item_key) AS (
    VALUES
      ('anchor_person_consent'),
      ('brand_kit'),
      ('copy'),
      ('persona_facts'),
      ('brand_kb_docs'),
      ('season0_approval'),
      ('events_calendar_90d'),
      ('seed_groups'),
      ('host_moderator_support_sla'),
      ('founding_invites_30'),
      ('revenue_share'),
      ('locales'),
      ('health_claims_signoff')
  ),
  t AS (
    SELECT tn.tenant_id, tn.slug
    FROM public.tenants tn
    WHERE tn.tenant_id = p_tenant_id
  ),
  items AS (
    SELECT c.item_key, COALESCE(i.status, 'not_started') AS status
    FROM checklist c
    LEFT JOIN public.tenant_pack_intake i
      ON i.tenant_id = p_tenant_id AND i.item_key = c.item_key
  )
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM t) THEN NULL ELSE jsonb_build_object(
    'tenant_id',   p_tenant_id,
    'slug',        (SELECT t.slug FROM t),
    'total',       (SELECT count(*) FROM items),
    'approved',    (SELECT count(*) FROM items WHERE status = 'approved'),
    'in_progress', (SELECT count(*) FROM items WHERE status = 'in_progress'),
    'blocked',     (SELECT count(*) FROM items WHERE status = 'blocked'),
    'not_started', (SELECT count(*) FROM items WHERE status = 'not_started'),
    'complete',    NOT EXISTS (SELECT 1 FROM items WHERE status <> 'approved'),
    'items',       (SELECT jsonb_object_agg(item_key, status ORDER BY item_key) FROM items),
    'outstanding', (SELECT COALESCE(jsonb_agg(item_key ORDER BY item_key), '[]'::jsonb)
                    FROM items WHERE status <> 'approved')
  ) END;
$fn$;

COMMENT ON FUNCTION public.get_tenant_launch_readiness(uuid) IS
  'VTID-05324: read-only WS8 intake completeness for one tenant. Reads tenant_pack_intake + tenants only. Service role only.';

REVOKE ALL ON FUNCTION public.get_tenant_launch_readiness(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_tenant_launch_readiness(uuid) TO service_role;

COMMIT;
