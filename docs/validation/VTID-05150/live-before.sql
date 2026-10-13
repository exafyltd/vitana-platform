-- VTID-05150 pre-check — READ-ONLY. Run against the production project right
-- before the apply window; keep the output with the release evidence.
-- Expected 2026-10-13: 2 tenants (maxina 2e7528b8…, alkalma 73cc592f…), both with
-- a tenant_settings row; reserved_tenant_slugs absent; provision_tenant absent.

-- 1. tenants + the full existing tenant_settings rows, with an md5 per row of the
--    six existing jsonb columns + updated_at (post-apply-checks.sql compares it).
SELECT t.tenant_id, t.slug, t.name, t.is_active, t.open_signup FROM public.tenants t ORDER BY t.slug;
SELECT s.tenant_id,
       md5(row_to_json((SELECT x FROM (SELECT s.profile, s.branding, s.feature_flags, s.integrations, s.domains, s.billing, s.updated_at) x))::text) AS existing_md5
  FROM public.tenant_settings s ORDER BY s.tenant_id;

-- 2. row counts per tenant in the tables provision_tenant() writes.
SELECT t.slug,
  (SELECT count(*) FROM public.notification_type_controls c WHERE c.tenant_id = t.tenant_id) AS controls,
  (SELECT count(*) FROM public.ai_provider_policies p WHERE p.tenant_id = t.tenant_id) AS policies,
  (SELECT count(*) FROM public.tenant_autopilot_settings a WHERE a.tenant_id = t.tenant_id) AS autopilot,
  (SELECT count(*) FROM public.chat_groups g WHERE g.tenant_id = t.tenant_id) AS groups,
  (SELECT count(*) FROM public.chat_group_members m WHERE m.tenant_id = t.tenant_id) AS group_members,
  (SELECT count(*) FROM public.tenant_invitations i WHERE i.tenant_id = t.tenant_id) AS invitations
  FROM public.tenants t ORDER BY t.slug;

-- 3. objects this slice creates must not exist yet.
SELECT to_regclass('public.reserved_tenant_slugs') IS NULL AS reserved_table_absent,
       to_regprocedure('public.provision_tenant(text, text, text, uuid, text, text, numeric, text, text[], text, text)') IS NULL AS provision_fn_absent,
       to_regprocedure('public.tenant_settings_merge_feature_flags(uuid, jsonb, boolean, uuid)') IS NULL AS merge_fn_absent,
       NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tenant_settings' AND column_name = 'provisioned_at') AS pack_columns_absent;

-- 4. B-M2 gate: Lane A M1 must be applied (both columns present, maxina the one default).
--    If this returns false, DO NOT apply 20261014000500 (the migration refuses anyway).
SELECT (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name IN ('is_default', 'is_platform')) = 2 AS lane_a_m1_applied;
-- (only after it returned true:) SELECT slug FROM public.tenants WHERE is_default;  -- expect maxina

-- 5. the platform notification baseline the function will compute (expect 16 rows).
SELECT c.type, c.source_key, bool_or(c.enabled) AS enabled
  FROM public.notification_type_controls c JOIN public.tenants t ON t.tenant_id = c.tenant_id AND t.is_active
 GROUP BY c.type, c.source_key
HAVING count(DISTINCT c.tenant_id) = (SELECT count(*) FROM public.tenants t2 WHERE t2.is_active
                                       AND EXISTS (SELECT 1 FROM public.notification_type_controls c2 WHERE c2.tenant_id = t2.tenant_id))
 ORDER BY 1;

-- 6. the bucket must not exist yet.
SELECT count(*) AS tenant_assets_bucket FROM storage.buckets WHERE id = 'tenant-assets';
