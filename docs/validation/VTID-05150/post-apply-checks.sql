-- VTID-05150 post-apply checks — READ-ONLY.

-- ── after 20261014000400 (B-M1) ────────────────────────────────────────────
-- 1. existing columns unchanged: compare with live-before.sql §1 (same md5 per tenant).
SELECT s.tenant_id,
       md5(row_to_json((SELECT x FROM (SELECT s.profile, s.branding, s.feature_flags, s.integrations, s.domains, s.billing, s.updated_at) x))::text) AS existing_md5
  FROM public.tenant_settings s ORDER BY s.tenant_id;

-- 2. new columns = the backfill values (maxina, alkalma); every other row = defaults.
SELECT tenant_id, display_name, brand, legal_entity_line, support_email, sender_name, sender_email,
       default_locale, enabled_locales, timezone, currency, landing, persona_facts, provisioned_at, provisioned_by
  FROM public.tenant_settings ORDER BY tenant_id;
-- expect: 2e7528b8… 'Maxina' {"colors":{"bg":"#FFF5F8","fg":"#1A1A1A","accent":"#FF7BAC"}} 'Exafy LTD' support@vitanaland.com
--         'Maxina by VITANA' noreply@vitanaland.com de {de,en,es,sr,fr,pl,pt,ru,tr,zh,ar} Europe/Berlin EUR {} {community_name Maxina, …}
--         73cc592f… 'AlKalma' {"colors":{"bg":"#EFF6FF","fg":"#1A1A1A","accent":"#3B82F6"}} 'Exafy LTD' NULL NULL NULL … {"community_name":"Alkalma"}

-- 3. reserved slugs = the JSON (112 on 2026-10-13: 67 spa_routes ∪ 22 public_files ∪ 31 platform, deduplicated).
SELECT count(*) AS reserved, count(*) FILTER (WHERE source = 'platform') AS platform,
       bool_and(added_vtid = 'VTID-05150') AS all_tagged
  FROM public.reserved_tenant_slugs;

-- 4. access: members cannot read the reserved list or call the merge function.
SELECT has_table_privilege('anon', 'public.reserved_tenant_slugs', 'SELECT') AS anon_reads_reserved,                 -- false
       has_table_privilege('authenticated', 'public.reserved_tenant_slugs', 'SELECT') AS auth_reads_reserved,      -- false
       has_function_privilege('anon', 'public.tenant_settings_merge_feature_flags(uuid, jsonb, boolean, uuid)', 'EXECUTE') AS anon_merge,          -- false
       has_function_privilege('authenticated', 'public.tenant_settings_merge_feature_flags(uuid, jsonb, boolean, uuid)', 'EXECUTE') AS auth_merge, -- false
       has_function_privilege('service_role', 'public.tenant_settings_merge_feature_flags(uuid, jsonb, boolean, uuid)', 'EXECUTE') AS svc_merge;   -- true

-- ── after 20261014000500 (B-M2) ────────────────────────────────────────────
-- 5. provision_tenant: service_role only, SECURITY DEFINER, search_path pinned.
SELECT has_function_privilege('anon', 'public.provision_tenant(text, text, text, uuid, text, text, numeric, text, text[], text, text)', 'EXECUTE') AS anon_exec,           -- false
       has_function_privilege('authenticated', 'public.provision_tenant(text, text, text, uuid, text, text, numeric, text, text[], text, text)', 'EXECUTE') AS auth_exec,  -- false
       has_function_privilege('service_role', 'public.provision_tenant(text, text, text, uuid, text, text, numeric, text, text[], text, text)', 'EXECUTE') AS svc_exec,    -- true
       p.prosecdef, p.proconfig
  FROM pg_proc p WHERE p.oid = 'public.provision_tenant(text, text, text, uuid, text, text, numeric, text, text[], text, text)'::regprocedure;

-- 6. nothing provisioned by the migrations themselves; counts per tenant unchanged
--    (compare with live-before.sql §2).
SELECT count(*) AS provisioned_rows FROM public.tenant_settings WHERE provisioned_at IS NOT NULL;  -- 0
SELECT t.slug,
  (SELECT count(*) FROM public.notification_type_controls c WHERE c.tenant_id = t.tenant_id) AS controls,
  (SELECT count(*) FROM public.ai_provider_policies p WHERE p.tenant_id = t.tenant_id) AS policies,
  (SELECT count(*) FROM public.tenant_autopilot_settings a WHERE a.tenant_id = t.tenant_id) AS autopilot,
  (SELECT count(*) FROM public.chat_groups g WHERE g.tenant_id = t.tenant_id) AS groups,
  (SELECT count(*) FROM public.chat_group_members m WHERE m.tenant_id = t.tenant_id) AS group_members,
  (SELECT count(*) FROM public.tenant_invitations i WHERE i.tenant_id = t.tenant_id) AS invitations
  FROM public.tenants t ORDER BY t.slug;

-- ── after the bucket script ────────────────────────────────────────────────
SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'tenant-assets';
-- expect: tenant-assets | true | 1048576 | {image/png,image/jpeg,image/webp}
SELECT count(*) AS client_policies FROM pg_policies WHERE schemaname = 'storage' AND qual ILIKE '%tenant-assets%';  -- 0
