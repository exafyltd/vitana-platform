-- VTID-05151 (multi-tenant M0, lane C, migration 2 of 2): seed the two legacy tenants' brand and
-- landing data, so the per-tenant branches the frontend compiled in today become data.
--
--  * alkalma tenant_settings.branding gains display_name "AlKalma" and the colours compiled into
--    vitana-v1 today (useTenant.tsx TENANT_CONFIGS.alkalma, AppLayout.tsx display-name ladder).
--  * maxina  profile.landing = intro, auto-switch on visit, post-login /onboarding/welcome, OAuth.
--  * alkalma profile.landing = intro, auto-switch on visit, post-login /home, OAuth.
--    (Today a signed-in Alkalma member is sent to /alkalma; /alkalma becomes the generic portal,
--    so the member now lands on /home directly — a deliberate change for Alkalma's 1 member.)
--
-- Existing keys always win (`seed || existing`), so re-running changes nothing (updated_at is left alone too) and a value an
-- admin set before this runs is kept. Touches exactly the 2 tenant_settings rows of maxina and
-- alkalma; maxina's branding is left as is (its colours are already in the database).
--
-- Snapshot first: legacy_archive.bak_vtid_05151_tenant_settings (not exposed to clients,
-- VTID-04880), kept 30 days. CREATE TABLE IF NOT EXISTS keeps the first (pre-seed) snapshot on
-- a re-run.
--
-- Requires 20261014000600_vtid_05151_public_tenant_registry.sql (the post-assert reads it).
-- Rollback: docs/validation/VTID-05151/rollback-seed.sql (restores branding/profile of the two
-- rows from the snapshot).

-- impact-allow-solo-migration: data seed read by the public tenant registry; the vitana-v1
-- consumers ship in their own PRs.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS legacy_archive;
REVOKE ALL ON SCHEMA legacy_archive FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS legacy_archive.bak_vtid_05151_tenant_settings AS
SELECT s.tenant_id, s.branding, s.profile, now() AS captured_at
  FROM public.tenant_settings s;

DO $$
DECLARE
  n int;
  total int := 0;
BEGIN
  UPDATE public.tenant_settings s
     SET branding = '{"display_name":"AlKalma","brand_accent":"#3B82F6","brand_bg":"#EFF6FF","brand_fg":"#1A1A1A"}'::jsonb
                    || coalesce(s.branding, '{}'::jsonb),
         profile  = jsonb_set(coalesce(s.profile, '{}'::jsonb), '{landing}',
                      '{"intro":true,"auto_switch_on_visit":true,"post_login_path":"/home","oauth":true}'::jsonb
                      || CASE WHEN jsonb_typeof(s.profile -> 'landing') = 'object' THEN s.profile -> 'landing' ELSE '{}'::jsonb END)
   WHERE s.tenant_id = (SELECT t.tenant_id FROM public.tenants t WHERE t.slug = 'alkalma');
  GET DIAGNOSTICS n = ROW_COUNT;
  total := total + n;

  UPDATE public.tenant_settings s
     SET profile  = jsonb_set(coalesce(s.profile, '{}'::jsonb), '{landing}',
                      '{"intro":true,"auto_switch_on_visit":true,"post_login_path":"/onboarding/welcome","oauth":true}'::jsonb
                      || CASE WHEN jsonb_typeof(s.profile -> 'landing') = 'object' THEN s.profile -> 'landing' ELSE '{}'::jsonb END)
   WHERE s.tenant_id = (SELECT t.tenant_id FROM public.tenants t WHERE t.slug = 'maxina');
  GET DIAGNOSTICS n = ROW_COUNT;
  total := total + n;

  IF total <> 2 THEN
    RAISE EXCEPTION 'VTID-05151: expected to seed 2 tenant_settings rows (maxina, alkalma), touched %', total;
  END IF;

  -- End state through the public registry.
  IF NOT EXISTS (SELECT 1 FROM public.resolve_tenant('alkalma')
                  WHERE display_name = 'AlKalma' AND (landing ->> 'post_login_path') = '/home'
                    AND (landing ->> 'auto_switch_on_visit')::boolean) THEN
    RAISE EXCEPTION 'VTID-05151: alkalma registry entry not seeded as expected';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.resolve_tenant('maxina')
                  WHERE display_name = 'Maxina' AND (landing ->> 'post_login_path') = '/onboarding/welcome'
                    AND (landing ->> 'intro')::boolean AND brand ->> 'accent' IS NOT NULL) THEN
    RAISE EXCEPTION 'VTID-05151: maxina registry entry not seeded as expected';
  END IF;
END $$;

COMMIT;
