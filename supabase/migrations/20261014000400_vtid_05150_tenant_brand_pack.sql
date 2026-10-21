-- VTID-05150 (multi-tenant M0, lane B, migration 1 of 2): tenant brand pack +
-- reserved tenant slugs + the tenant-admin feature_flags merge.
--
-- Expand only. Nothing reads the new columns in this slice (consumers are
-- WS5/WS7, each with its own golden test), so Maxina and Alkalma behave exactly
-- as before; the two backfill UPDATEs write the NEW columns only.
--
-- 1. tenant_settings gains the Exafy-governed brand pack (14 columns). They live
--    on tenant_settings, not tenants: tenants is readable by every signed-in
--    user, tenant_settings only by active members + service_role. The
--    tenant-admin PUT /settings writes only profile/branding/feature_flags/
--    integrations/domains (+updated_*), so it can never touch these columns.
--    Defaults equal today's platform behaviour (de, 11 GA locales,
--    Europe/Berlin, EUR), so an absent value changes nothing.
-- 2. tenant_settings_brand_pack_validate() (SECURITY INVOKER) checks locales
--    against supported_locales, the timezone against pg_timezone_names and that
--    every brand/landing *_path stays under '<tenants.slug>/' without '..'.
-- 3. reserved_tenant_slugs: slugs a tenant may never take (program D5 path URL
--    vitanaland.com/<slug> collides with SPA top-level routes). Seeded from
--    services/gateway/src/services/tenant-provisioning/reserved-slugs.json
--    (scripts/tenants/gen-reserved-slugs.mjs; vtid-05150-reserved-slugs.test.ts
--    pins seed == JSON). A slug listed under several sources is seeded once,
--    platform > spa_route > public_file.
-- 4. tenant_settings_merge_feature_flags(): the tenant-admin PUT merges
--    feature_flags in one statement and keeps the governed `jev` key (enabled,
--    planes, monthly_budget_usd) unless the caller is exafy_admin (plan Risk 4).
--
-- Rollback: docs/validation/VTID-05150/rollback.sql (+ rollback-complete.sql).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ── 1. brand pack columns (constant defaults → metadata-only) ──────────────
ALTER TABLE public.tenant_settings
  ADD COLUMN IF NOT EXISTS display_name      text,
  ADD COLUMN IF NOT EXISTS brand             jsonb  NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS legal_entity_line text,
  ADD COLUMN IF NOT EXISTS support_email     text,
  ADD COLUMN IF NOT EXISTS sender_name       text,
  ADD COLUMN IF NOT EXISTS sender_email      text,
  ADD COLUMN IF NOT EXISTS default_locale    text   NOT NULL DEFAULT 'de',
  ADD COLUMN IF NOT EXISTS enabled_locales   text[] NOT NULL DEFAULT '{de,en,es,sr,fr,pl,pt,ru,tr,zh,ar}'::text[],
  ADD COLUMN IF NOT EXISTS timezone          text   NOT NULL DEFAULT 'Europe/Berlin',
  ADD COLUMN IF NOT EXISTS currency          text   NOT NULL DEFAULT 'EUR',
  ADD COLUMN IF NOT EXISTS landing           jsonb  NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS persona_facts     jsonb  NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS provisioned_at    timestamptz,
  ADD COLUMN IF NOT EXISTS provisioned_by    uuid;

COMMENT ON COLUMN public.tenant_settings.persona_facts IS
  'VTID-05150: FACTS only (community_name, community_pronunciation, anchor_person, story_facts[], offer_facts[], tone[]); never a sentence Vitana speaks (CLAUDE.md rule 41). Exafy-governed.';
COMMENT ON COLUMN public.tenant_settings.provisioned_at IS
  'VTID-05150: set by provision_tenant(); NULL = legacy tenant (maxina, alkalma, hand-made) that provisioning never touches.';

-- ── CHECKs (NOT VALID, then VALIDATE: 2 rows) ──────────────────────────────
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.tenant_settings'::regclass AND conname = 'tenant_settings_brand_pack_check') THEN
    ALTER TABLE public.tenant_settings ADD CONSTRAINT tenant_settings_brand_pack_check CHECK (
          (support_email IS NULL OR support_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
      AND (sender_email  IS NULL OR sender_email  ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
      AND currency ~ '^[A-Z]{3}$'
      AND cardinality(enabled_locales) > 0
      AND default_locale = ANY (enabled_locales)
      AND jsonb_typeof(brand) = 'object'
      AND jsonb_typeof(landing) = 'object'
      AND jsonb_typeof(persona_facts) = 'object'
      AND (legal_entity_line IS NULL OR char_length(legal_entity_line) <= 200)
    ) NOT VALID;
  END IF;
END $chk$;
ALTER TABLE public.tenant_settings VALIDATE CONSTRAINT tenant_settings_brand_pack_check;

-- ── 2. validation trigger ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tenant_settings_brand_pack_validate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  v_slug text;
  v_loc  text;
  v_kv   record;
BEGIN
  FOREACH v_loc IN ARRAY NEW.enabled_locales LOOP
    IF NOT EXISTS (SELECT 1 FROM public.supported_locales l WHERE l.code = v_loc) THEN
      RAISE EXCEPTION 'INVALID_LOCALE: % is not in supported_locales', v_loc USING ERRCODE = '22023';
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name = NEW.timezone) THEN
    RAISE EXCEPTION 'INVALID_TIMEZONE: %', NEW.timezone USING ERRCODE = '22023';
  END IF;

  FOR v_kv IN
    SELECT key, value FROM jsonb_each(NEW.brand) WHERE key LIKE '%\_path'
    UNION ALL
    SELECT key, value FROM jsonb_each(NEW.landing) WHERE key LIKE '%\_path'
  LOOP
    IF jsonb_typeof(v_kv.value) = 'null' THEN CONTINUE; END IF;
    IF v_slug IS NULL THEN
      SELECT t.slug INTO v_slug FROM public.tenants t WHERE t.tenant_id = NEW.tenant_id;
      IF v_slug IS NULL THEN
        RAISE EXCEPTION 'INVALID_ASSET_PATH: tenant % has no slug', NEW.tenant_id USING ERRCODE = '22023';
      END IF;
    END IF;
    IF jsonb_typeof(v_kv.value) <> 'string'
       OR left(v_kv.value #>> '{}', char_length(v_slug) + 1) <> v_slug || '/'
       OR position('..' IN v_kv.value #>> '{}') > 0 THEN
      RAISE EXCEPTION 'INVALID_ASSET_PATH: % must start with %/ and contain no ..', v_kv.key, v_slug USING ERRCODE = '22023';
    END IF;
  END LOOP;

  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.tenant_settings_brand_pack_validate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tenant_settings_brand_pack_validate ON public.tenant_settings;
CREATE TRIGGER tenant_settings_brand_pack_validate
  BEFORE INSERT OR UPDATE OF enabled_locales, default_locale, timezone, brand, landing
  ON public.tenant_settings
  FOR EACH ROW EXECUTE FUNCTION public.tenant_settings_brand_pack_validate();

-- ── 3. reserved tenant slugs ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reserved_tenant_slugs (
  slug       text PRIMARY KEY,
  source     text NOT NULL CHECK (source IN ('spa_route', 'public_file', 'platform')),
  added_vtid text
);
ALTER TABLE public.reserved_tenant_slugs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.reserved_tenant_slugs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.reserved_tenant_slugs TO service_role;
COMMENT ON TABLE public.reserved_tenant_slugs IS
  'VTID-05150: slugs no tenant may take (vitana-v1 top-level routes, public/ files, platform words). Source: services/gateway/src/services/tenant-provisioning/reserved-slugs.json; drift: TENANT-RESERVED-SLUGS-DRIFT.yml.';

INSERT INTO public.reserved_tenant_slugs (slug, source) VALUES
  ('admin','platform'), ('ai','spa_route'), ('alive','platform'), ('alkalma','spa_route'),
  ('api','platform'), ('app','platform'), ('apple-touch-icon','public_file'), ('apply','spa_route'),
  ('assets','platform'), ('assistant','spa_route'), ('audio-processor','public_file'), ('auth','platform'),
  ('autopilot','spa_route'), ('backoffice','platform'), ('boot-recover','public_file'), ('brand','public_file'),
  ('business','spa_route'), ('calendar','spa_route'), ('cart','spa_route'), ('checkout','spa_route'),
  ('comm','spa_route'), ('command-hub','platform'), ('commerce','spa_route'), ('commerce-login','spa_route'),
  ('community','spa_route'), ('connectors','spa_route'), ('creator','spa_route'), ('daily-diary','spa_route'),
  ('dashboard','spa_route'), ('delete-account','spa_route'), ('dev','platform'), ('discover','spa_route'),
  ('docs','platform'), ('download','spa_route'), ('e','spa_route'), ('earthlinks','spa_route'),
  ('exafy','platform'), ('exafy-admin','spa_route'), ('favicon','public_file'), ('favicon-16x16','public_file'),
  ('favicon-32x32','public_file'), ('firebase-messaging-sw','public_file'), ('group-avatars','public_file'), ('health','platform'),
  ('health-tracker','spa_route'), ('help','platform'), ('home','spa_route'), ('i','spa_route'),
  ('illustrations','public_file'), ('images','public_file'), ('inbox','spa_route'), ('intents','spa_route'),
  ('invite','platform'), ('join','platform'), ('login','platform'), ('logout','spa_route'),
  ('lovable-uploads','public_file'), ('mail','platform'), ('maxina','spa_route'), ('me','spa_route'),
  ('memory','spa_route'), ('messages','spa_route'), ('mock','public_file'), ('my-tickets','spa_route'),
  ('new','platform'), ('news','spa_route'), ('null','platform'), ('oauth','spa_route'),
  ('og-download','public_file'), ('onboarding','spa_route'), ('packages','spa_route'), ('partner','spa_route'),
  ('patient','spa_route'), ('placeholder','public_file'), ('platform','platform'), ('post','spa_route'),
  ('preview','platform'), ('privacy','spa_route'), ('professional','spa_route'), ('profile','spa_route'),
  ('pub','spa_route'), ('redeem','spa_route'), ('register','spa_route'), ('reminders','spa_route'),
  ('reset-password','spa_route'), ('robots','public_file'), ('search','spa_route'), ('settings','spa_route'),
  ('sharing','spa_route'), ('shop','spa_route'), ('signup','platform'), ('sounds','public_file'),
  ('staff','spa_route'), ('staging','platform'), ('static','platform'), ('status','platform'),
  ('support','platform'), ('sw','public_file'), ('terms','spa_route'), ('tickets','spa_route'),
  ('training','public_file'), ('u','spa_route'), ('undefined','platform'), ('universal-cart','spa_route'),
  ('videos','public_file'), ('vitana','platform'), ('vitana-orb-avatar','public_file'), ('vitana-orb-clean','public_file'),
  ('vitanaland','platform'), ('vitanaland-platform','platform'), ('wallet','spa_route'), ('www','platform')
ON CONFLICT (slug) DO NOTHING;
UPDATE public.reserved_tenant_slugs SET added_vtid = 'VTID-05150' WHERE added_vtid IS NULL;

-- ── 4. tenant-admin feature_flags merge (one statement, no read-modify-write) ─
-- Top-level key merge: keys the client sends replace the stored value, other
-- stored keys stay. For a non-exafy_admin caller `jev` is dropped from the
-- client's object first, so the stored `jev` is kept whole.
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
    CASE WHEN p_allow_governed THEN coalesce(p_flags, '{}'::jsonb) ELSE coalesce(p_flags, '{}'::jsonb) - 'jev' END,
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

-- ── backfill: values from where they live today (plan Problem 4) ───────────
-- New columns only; guarded so a re-run is a no-op. On a database without the
-- two legacy tenants (local replay) the backfill is skipped with a NOTICE.
DO $backfill$
DECLARE
  v_maxina  constant uuid := '2e7528b8-472a-4356-88da-0280d4639cce';
  v_alkalma constant uuid := '73cc592f-84ec-457a-b0f7-25a082d7e011';
  n int;
BEGIN
  IF EXISTS (SELECT 1 FROM public.tenants WHERE slug IN ('maxina', 'alkalma')
             AND tenant_id NOT IN (v_maxina, v_alkalma)) THEN
    RAISE EXCEPTION 'VTID-05150: maxina/alkalma tenant_id differs from the live ids — backfill refused';
  END IF;

  UPDATE public.tenant_settings SET
    display_name      = 'Maxina',
    brand             = '{"colors":{"accent":"#FF7BAC","bg":"#FFF5F8","fg":"#1A1A1A"}}'::jsonb,
    legal_entity_line = 'Exafy LTD',
    support_email     = 'support@vitanaland.com',
    sender_name       = 'Maxina by VITANA',
    sender_email      = 'noreply@vitanaland.com',
    persona_facts     = '{"community_name":"Maxina","community_pronunciation":"mah-KSEE-nah"}'::jsonb
  WHERE tenant_id = v_maxina AND provisioned_at IS NULL AND display_name IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    IF EXISTS (SELECT 1 FROM public.tenants WHERE tenant_id = v_maxina)
       AND NOT EXISTS (SELECT 1 FROM public.tenant_settings WHERE tenant_id = v_maxina AND display_name = 'Maxina') THEN
      RAISE EXCEPTION 'VTID-05150: maxina backfill touched % rows (expected 1)', n;
    END IF;
    RAISE NOTICE 'VTID-05150: maxina backfill skipped (already done or tenant absent)';
  END IF;

  UPDATE public.tenant_settings SET
    display_name      = 'AlKalma',
    brand             = '{"colors":{"accent":"#3B82F6","bg":"#EFF6FF","fg":"#1A1A1A"}}'::jsonb,
    legal_entity_line = 'Exafy LTD',
    persona_facts     = '{"community_name":"Alkalma"}'::jsonb
  WHERE tenant_id = v_alkalma AND provisioned_at IS NULL AND display_name IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    IF EXISTS (SELECT 1 FROM public.tenants WHERE tenant_id = v_alkalma)
       AND NOT EXISTS (SELECT 1 FROM public.tenant_settings WHERE tenant_id = v_alkalma AND display_name = 'AlKalma') THEN
      RAISE EXCEPTION 'VTID-05150: alkalma backfill touched % rows (expected 1)', n;
    END IF;
    RAISE NOTICE 'VTID-05150: alkalma backfill skipped (already done or tenant absent)';
  END IF;
END
$backfill$;

COMMIT;
