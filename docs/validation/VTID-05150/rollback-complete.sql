-- VTID-05150 rollback, step 2 of 2 — finishes rollback.sql.
--
-- MAY RUN ONLY WHEN: rollback.sql has run and stopped with "STOPPED before
-- dropping columns", AND a person has reviewed public.bak_vtid_05150_tenant_settings
-- (it holds every tenant's brand pack) and approved dropping the columns.
-- It drops the 14 brand-pack columns and the CHECK. The bak_ table is kept for
-- its 30 days (drop it by hand afterwards). Refuses when the backup is missing
-- or does not cover every provisioned tenant.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regclass('public.bak_vtid_05150_tenant_settings') IS NULL THEN
    RAISE EXCEPTION 'VTID-05150 rollback-complete: bak_vtid_05150_tenant_settings missing — run rollback.sql first';
  END IF;
  IF to_regprocedure('public.provision_tenant(text, text, text, uuid, text, text, numeric, text, text[], text, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'VTID-05150 rollback-complete: provision_tenant still exists — run rollback.sql first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tenant_settings s
              WHERE s.provisioned_at IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM public.bak_vtid_05150_tenant_settings b
                                 WHERE b.tenant_id = s.tenant_id AND b.provisioned_at IS NOT DISTINCT FROM s.provisioned_at)) THEN
    RAISE EXCEPTION 'VTID-05150 rollback-complete: a provisioned tenant is not in the backup — re-run rollback.sql';
  END IF;
END
$guard$;

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

COMMIT;
