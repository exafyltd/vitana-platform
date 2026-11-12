-- VTID-05506 (mt-m3-r2/provision-erp-monitoring-db, E1): provision_tenant() records the ERP bootstrap request, and `erp`
-- becomes a governed key of tenant_settings_merge_feature_flags().
--
--  1. provision_tenant(): IDENTICAL signature and body to 20261014000500 (VTID-05150) plus one guarded UPDATE straight after
--     the tenant_settings INSERT ... ON CONFLICT DO NOTHING that sets feature_flags.erp.bootstrap_requested = true. The
--     UPDATE runs on every call, so a re-run on an already provisioned tenant (including one provisioned before this
--     migration) records the flag too; it is a no-op once the flag is true. The return value is unchanged.
--  2. tenant_settings_merge_feature_flags(): a caller that is not an exafy_admin (p_allow_governed = false) can no longer
--     send `erp` either (`- 'jev' - 'erp'`), so a tenant admin cannot forge or clear the bootstrap request.
-- Nothing reads the flag yet (a consumer is a separate ERP-bootstrap spec). Expand-only, idempotent, no new table, no policy.
-- Rollback: docs/validation/VTID-05506/rollback-141000-provision-erp-request.sql (restores both 05150 bodies).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
BEGIN
  IF to_regprocedure('public.provision_tenant(text,text,text,uuid,text,text,numeric,text,text[],text,text)') IS NULL
     OR to_regprocedure('public.tenant_settings_merge_feature_flags(uuid,jsonb,boolean,uuid)') IS NULL THEN
    RAISE EXCEPTION 'VTID-05506: apply 20261014000400 / 20261014000500 (VTID-05150: provision_tenant, tenant_settings_merge_feature_flags) first';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.provision_tenant(
  p_slug                    text,
  p_name                    text,
  p_admin_email             text,
  p_invited_by              uuid,
  p_all_members_group_name  text,
  p_display_name            text    DEFAULT NULL,
  p_jev_monthly_budget_usd  numeric DEFAULT 10,
  p_default_locale          text    DEFAULT 'de',
  p_enabled_locales         text[]  DEFAULT NULL,
  p_timezone                text    DEFAULT 'Europe/Berlin',
  p_currency                text    DEFAULT 'EUR')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  -- The Vitana bot (Alle Beisammen pattern, 20260625000000).
  c_bot constant uuid := '00000000-0000-0000-0000-000000000001';
  v_email      text := lower(btrim(coalesce(p_admin_email, '')));
  v_name       text := btrim(coalesce(p_name, ''));
  v_group_name text := btrim(coalesce(p_all_members_group_name, ''));
  v_locales    text[];
  v_tid        uuid;
  v_existing_name text;
  v_existing_prov timestamptz;
  v_created    boolean;
  v_default    uuid;
  v_base_n     int;
  v_group_id   uuid;
  v_inv        record;
  v_reused     boolean := true;
BEGIN
  -- a. validation (no lock, no write) ------------------------------------
  IF p_slug IS NULL OR char_length(p_slug) NOT BETWEEN 3 AND 32
     OR p_slug !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'INVALID_SLUG' USING ERRCODE = '22023',
      DETAIL = 'slug: 3-32 chars, lowercase letters/digits, single hyphens, starts with a letter';
  END IF;
  IF char_length(v_name) NOT BETWEEN 1 AND 80 OR char_length(v_group_name) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'INVALID_NAME' USING ERRCODE = '22023', DETAIL = 'name and group name: 1-80 chars';
  END IF;
  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'INVALID_ADMIN_EMAIL' USING ERRCODE = '22023';
  END IF;
  IF p_jev_monthly_budget_usd IS NULL OR p_jev_monthly_budget_usd < 0 OR p_jev_monthly_budget_usd > 500 THEN
    RAISE EXCEPTION 'INVALID_PARAMS' USING ERRCODE = '22023', DETAIL = 'jev monthly budget: 0-500 USD';
  END IF;
  IF p_invited_by IS NULL OR NOT EXISTS (
       SELECT 1 FROM auth.users u WHERE u.id = p_invited_by AND u.raw_app_meta_data ->> 'exafy_admin' = 'true') THEN
    RAISE EXCEPTION 'NOT_EXAFY_ADMIN' USING ERRCODE = '22023';
  END IF;
  -- CLAUDE.md rules 43-45: a test/service/automation account never becomes a member.
  IF EXISTS (
       SELECT 1 FROM auth.users u
       WHERE lower(u.email) = v_email
         AND (EXISTS (SELECT 1 FROM public.service_bot_accounts s WHERE s.user_id = u.id)
              OR EXISTS (SELECT 1 FROM public.notification_test_actors a WHERE a.user_id = u.id)))
     OR v_email LIKE 'e2e-%' OR v_email LIKE '%@vitanatest.exafy.io' THEN
    RAISE EXCEPTION 'SERVICE_ACCOUNT_EMAIL' USING ERRCODE = '22023';
  END IF;

  -- One provisioning per slug at a time. Advisory-lock namespace 42001 is
  -- reserved for provision_tenant (two-key form, so no other function's lock
  -- can collide).
  PERFORM pg_advisory_xact_lock(42001, hashtext(p_slug));

  IF EXISTS (SELECT 1 FROM public.reserved_tenant_slugs r WHERE r.slug = p_slug) THEN
    RAISE EXCEPTION 'RESERVED_SLUG' USING ERRCODE = '22023';
  END IF;

  SELECT t.tenant_id INTO v_default FROM public.tenants t WHERE t.is_default LIMIT 1;
  IF v_default IS NULL THEN
    RAISE EXCEPTION 'NO_DEFAULT_TENANT' USING ERRCODE = '22023';
  END IF;

  -- b. tenant ---------------------------------------------------------------
  SELECT t.tenant_id, t.name, s.provisioned_at
    INTO v_tid, v_existing_name, v_existing_prov
    FROM public.tenants t LEFT JOIN public.tenant_settings s ON s.tenant_id = t.tenant_id
   WHERE t.slug = p_slug;
  IF FOUND THEN
    IF v_existing_prov IS NULL OR v_existing_name IS DISTINCT FROM v_name THEN
      RAISE EXCEPTION 'SLUG_TAKEN' USING ERRCODE = '22023';
    END IF;
    v_created := false;
  ELSE
    -- is_default / is_platform are not named: their DEFAULT false applies.
    INSERT INTO public.tenants (name, slug) VALUES (v_name, p_slug) RETURNING tenant_id INTO v_tid;
    v_created := true;
  END IF;

  -- c. settings + brand pack ---------------------------------------------------
  IF p_enabled_locales IS NULL THEN
    v_locales := '{de,en,es,sr,fr,pl,pt,ru,tr,zh,ar}'::text[];
  ELSE
    v_locales := p_enabled_locales;
  END IF;
  INSERT INTO public.tenant_settings (
    tenant_id, display_name, default_locale, enabled_locales, timezone, currency,
    feature_flags, provisioned_at, provisioned_by, updated_at, updated_by)
  VALUES (
    v_tid, coalesce(nullif(btrim(p_display_name), ''), v_name), p_default_locale, v_locales, p_timezone, p_currency,
    jsonb_build_object('jev', jsonb_build_object(
      'enabled', true,
      'planes', jsonb_build_array('internal', 'system_autopilot', 'member'),
      'monthly_budget_usd', p_jev_monthly_budget_usd)),
    now(), p_invited_by, now(), p_invited_by)
  ON CONFLICT (tenant_id) DO NOTHING;

  -- VTID-05506: record the ERP bootstrap request (design section 4.6) as tenant_settings.feature_flags.erp.bootstrap_requested.
  -- The INSERT above is DO NOTHING, so a re-run on an already provisioned tenant (also one provisioned before this
  -- migration) would never reach the flag: it is set here by a guarded UPDATE that runs on every call. IS DISTINCT FROM
  -- (not NOT (x = 'true')) because the path is NULL when absent. A non-object erp value is repaired; other erp subkeys stay.
  UPDATE public.tenant_settings s
     SET feature_flags = jsonb_set(
           coalesce(s.feature_flags, '{}'::jsonb), '{erp}',
           (CASE WHEN jsonb_typeof(s.feature_flags -> 'erp') = 'object' THEN s.feature_flags -> 'erp' ELSE '{}'::jsonb END)
             || '{"bootstrap_requested":true}'::jsonb),
         updated_at = now()
   WHERE s.tenant_id = v_tid
     AND (s.feature_flags #> '{erp,bootstrap_requested}') IS DISTINCT FROM 'true'::jsonb;

  -- d. instance data (gaps only) ------------------------------------------------
  -- Notification baseline: pairs held by EVERY other active, non-platform tenant
  -- that has controls at all. Tenant-local rows auto-registered OFF on first
  -- send exist in one tenant only and drop out; a type one tenant's admin
  -- switched off stays on (bool_or).
  WITH base AS (
    SELECT t.tenant_id FROM public.tenants t
     WHERE t.tenant_id <> v_tid AND t.is_active AND NOT t.is_platform
       AND EXISTS (SELECT 1 FROM public.notification_type_controls c WHERE c.tenant_id = t.tenant_id)
  )
  SELECT count(*) INTO v_base_n FROM base;
  IF v_base_n = 0 THEN
    RAISE EXCEPTION 'NO_NOTIFICATION_BASELINE' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.notification_type_controls (tenant_id, type, source_key, enabled, auto_registered, reason)
  SELECT v_tid, c.type, c.source_key, bool_or(c.enabled), false, 'VTID-05150: platform baseline at provisioning'
    FROM public.notification_type_controls c
    JOIN public.tenants t ON t.tenant_id = c.tenant_id
   WHERE t.tenant_id <> v_tid AND t.is_active AND NOT t.is_platform
   GROUP BY c.type, c.source_key
  HAVING count(DISTINCT c.tenant_id) = v_base_n
  ON CONFLICT (tenant_id, type, source_key) DO NOTHING;

  INSERT INTO public.ai_provider_policies (
    tenant_id, provider, allowed, allowed_models, cost_cap_usd_month, allowed_memory_categories, updated_by, updated_at)
  SELECT v_tid, p.provider, p.allowed, p.allowed_models, p.cost_cap_usd_month, p.allowed_memory_categories, NULL, now()
    FROM public.ai_provider_policies p
   WHERE p.tenant_id = v_default
  ON CONFLICT (tenant_id, provider) DO NOTHING;

  INSERT INTO public.tenant_autopilot_settings (tenant_id) VALUES (v_tid)
  ON CONFLICT (tenant_id) DO NOTHING;

  SELECT g.id INTO v_group_id FROM public.chat_groups g
   WHERE g.tenant_id = v_tid AND g.is_system AND g.metadata ->> 'seeded_by' = 'provision_tenant'
   ORDER BY g.created_at LIMIT 1;
  IF v_group_id IS NULL THEN
    INSERT INTO public.chat_groups (tenant_id, name, description, created_by, is_system, metadata)
    VALUES (v_tid, v_group_name, NULL, NULL, true, jsonb_build_object('cap', NULL, 'seeded_by', 'provision_tenant'))
    RETURNING id INTO v_group_id;
  END IF;
  INSERT INTO public.chat_group_members (group_id, user_id, tenant_id, role)
  VALUES (v_group_id, c_bot, v_tid, 'bot')
  ON CONFLICT (group_id, user_id) DO NOTHING;

  -- e. first-admin invitation ---------------------------------------------------
  SELECT i.id, i.token, i.expires_at INTO v_inv
    FROM public.tenant_invitations i
   WHERE i.tenant_id = v_tid AND lower(i.email) = v_email AND 'admin' = ANY (i.roles)
     AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
   ORDER BY i.created_at DESC
   LIMIT 1;
  IF NOT FOUND THEN
    INSERT INTO public.tenant_invitations (tenant_id, email, roles, invited_by)
    VALUES (v_tid, v_email, ARRAY['admin'], p_invited_by)
    RETURNING id, token, expires_at INTO v_inv;
    v_reused := false;
  END IF;

  RETURN jsonb_build_object(
    'tenant_id', v_tid,
    'slug', p_slug,
    'created', v_created,
    'invitation', jsonb_build_object('id', v_inv.id, 'token', v_inv.token, 'expires_at', v_inv.expires_at, 'reused', v_reused),
    'ensured', jsonb_build_object(
      'notification_controls', (SELECT count(*) FROM public.notification_type_controls WHERE tenant_id = v_tid),
      'ai_policies',           (SELECT count(*) FROM public.ai_provider_policies WHERE tenant_id = v_tid),
      'autopilot_settings',    (SELECT count(*) FROM public.tenant_autopilot_settings WHERE tenant_id = v_tid),
      'system_group',          (SELECT count(*) FROM public.chat_group_members m
                                 WHERE m.group_id = v_group_id AND m.user_id = c_bot AND m.role = 'bot')));
END
$fn$;

COMMENT ON FUNCTION public.provision_tenant(text, text, text, uuid, text, text, numeric, text, text[], text, text) IS
  'VTID-05150: create a new community (tenant, settings, instance data, first-admin invitation) in one transaction; VTID-05506: also records tenant_settings.feature_flags.erp.bootstrap_requested (idempotent, on every call). service_role only (gateway POST /api/v1/admin/tenants, exafy_admin). Advisory-lock namespace 42001 is reserved for this function: pg_advisory_xact_lock(42001, hashtext(slug)).';

REVOKE ALL ON FUNCTION public.provision_tenant(text, text, text, uuid, text, text, numeric, text, text[], text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_tenant(text, text, text, uuid, text, text, numeric, text, text[], text, text) TO service_role;

DO $check$
DECLARE
  fn constant text := 'public.provision_tenant(text, text, text, uuid, text, text, numeric, text, text[], text, text)';
BEGIN
  IF has_function_privilege('anon', fn, 'EXECUTE') OR has_function_privilege('authenticated', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05506: provision_tenant must not be executable by members (authenticated/anon)';
  END IF;
  IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05506: the gateway (service_role) must keep EXECUTE on provision_tenant';
  END IF;
END
$check$;


-- ── tenant_settings_merge_feature_flags(): `erp` is governed like `jev` ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tenant_settings_merge_feature_flags(
  p_tenant_id uuid, p_flags jsonb, p_allow_governed boolean, p_updated_by uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $fn$
  INSERT INTO public.tenant_settings AS s (tenant_id, feature_flags, updated_at, updated_by)
  VALUES (
    p_tenant_id,
    CASE WHEN p_allow_governed THEN coalesce(p_flags, '{}'::jsonb) ELSE coalesce(p_flags, '{}'::jsonb) - 'jev' - 'erp' END,
    now(),
    p_updated_by)
  ON CONFLICT (tenant_id) DO UPDATE SET
    feature_flags = coalesce(s.feature_flags, '{}'::jsonb) || EXCLUDED.feature_flags,
    updated_at    = now(),
    updated_by    = EXCLUDED.updated_by
  RETURNING to_jsonb(s.*);
$fn$;

REVOKE ALL ON FUNCTION public.tenant_settings_merge_feature_flags(uuid, jsonb, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_settings_merge_feature_flags(uuid, jsonb, boolean, uuid) TO service_role;

DO $check$
DECLARE
  fn constant text := 'public.tenant_settings_merge_feature_flags(uuid, jsonb, boolean, uuid)';
BEGIN
  IF has_function_privilege('anon', fn, 'EXECUTE') OR has_function_privilege('authenticated', fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05506: tenant_settings_merge_feature_flags must be executable by service_role only';
  END IF;
END
$check$;

COMMIT;
