-- VTID-05150 rollback, step 1 of 2 (both migrations: 20261014000500 then 20261014000400).
--
-- Removes provision_tenant(), the feature_flags merge function, the brand-pack
-- trigger + function and reserved_tenant_slugs. The 14 brand-pack columns are
-- dropped ONLY when no tenant was provisioned (provisioned_at IS NOT NULL = 0).
-- Otherwise the columns are first copied to bak_vtid_05150_tenant_settings
-- (keep 30 days) and this script STOPS before dropping them: a provisioned
-- tenant must not lose its pack silently. Finish with rollback-complete.sql
-- after the backup has been reviewed.
--
-- Data rows a provisioning call created (the tenant, its settings row, controls,
-- policies, autopilot row, system group, invitation) are NOT deleted here;
-- removing a tenant is its own owner-approved action.
-- Before rolling back 20261014000400 alone, revert the gateway first: the
-- tenant-admin PUT falls back to an in-gateway merge when the merge function is
-- missing, so it keeps working either way.

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS public.provision_tenant(text, text, text, uuid, text, text, numeric, text, text[], text, text);
DROP FUNCTION IF EXISTS public.tenant_settings_merge_feature_flags(uuid, jsonb, boolean, uuid);
DROP TRIGGER IF EXISTS tenant_settings_brand_pack_validate ON public.tenant_settings;
DROP FUNCTION IF EXISTS public.tenant_settings_brand_pack_validate();
DROP TABLE IF EXISTS public.reserved_tenant_slugs;

DO $rb$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM public.tenant_settings WHERE provisioned_at IS NOT NULL;
  IF n = 0 THEN
    ALTER TABLE public.tenant_settings
      DROP CONSTRAINT IF EXISTS tenant_settings_brand_pack_check,
      DROP COLUMN IF EXISTS display_name,
      DROP COLUMN IF EXISTS brand,
      DROP COLUMN IF EXISTS legal_entity_line,
      DROP COLUMN IF EXISTS support_email,
      DROP COLUMN IF EXISTS sender_name,
      DROP COLUMN IF EXISTS sender_email,
      DROP COLUMN IF EXISTS default_locale,
      DROP COLUMN IF EXISTS enabled_locales,
      DROP COLUMN IF EXISTS timezone,
      DROP COLUMN IF EXISTS currency,
      DROP COLUMN IF EXISTS landing,
      DROP COLUMN IF EXISTS persona_facts,
      DROP COLUMN IF EXISTS provisioned_at,
      DROP COLUMN IF EXISTS provisioned_by;
    RAISE NOTICE 'VTID-05150 rollback: complete (no provisioned tenant; brand-pack columns dropped)';
  ELSE
    IF to_regclass('public.bak_vtid_05150_tenant_settings') IS NULL THEN
      CREATE TABLE public.bak_vtid_05150_tenant_settings AS
        SELECT tenant_id, display_name, brand, legal_entity_line, support_email, sender_name, sender_email,
               default_locale, enabled_locales, timezone, currency, landing, persona_facts,
               provisioned_at, provisioned_by, now() AS backed_up_at
          FROM public.tenant_settings;
      REVOKE ALL ON TABLE public.bak_vtid_05150_tenant_settings FROM PUBLIC, anon, authenticated;
      COMMENT ON TABLE public.bak_vtid_05150_tenant_settings IS
        'VTID-05150 rollback backup of the tenant brand pack (keep 30 days, then drop).';
    END IF;
    RAISE NOTICE 'VTID-05150 rollback: STOPPED before dropping columns — % provisioned tenant(s); pack copied to bak_vtid_05150_tenant_settings. Review it, then run rollback-complete.sql.', n;
  END IF;
END
$rb$;

COMMIT;
