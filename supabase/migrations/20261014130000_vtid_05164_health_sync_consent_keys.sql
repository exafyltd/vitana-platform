-- =============================================================================
-- VTID-05164 — Health Hub Phase 1 / C1: Health Sync consent keys and the
-- phone health-store connectors (program VTID-05020, shared interface S7).
-- -----------------------------------------------------------------------------
-- APPLY TARGET: Supabase via RUN-MIGRATION.yml, only after this change's
-- Gate 2. Builds on 20261012180000_vtid_05092_health_consent_categories.sql
-- (D10 WP1: the catalogue table, the replaced granted_via CHECK and
-- fn_set_health_consent) and refuses to run without it.
--
-- Purely additive (no table, column or row is dropped):
--   1. connector_registry.category CHECK widened as a superset
--      (social, wearable, shop, calendar, productivity, aggregator,
--      ai_assistant — 20260417000000 / 20260419000000 — plus health_store).
--   2. connector_registry rows apple_health and health_connect (category
--      health_store, auth_type sdk_bridge — already allowed). Seeded
--      enabled = FALSE, like the frozen polling connectors: nothing lists them
--      to members until the native Health Sync module ships; the rows exist so
--      the sync_* consents name a registered connector and
--      health_sources.connector_id (VTID-05161, Aurora) can reference them.
--   3. data_sharing_consents.granted_via CHECK: every value VTID-05092 allows
--      plus native_health_sync. This is the ONLY Phase 1 migration that
--      touches that CHECK. fn_set_health_consent is re-created with the same
--      body and the same wider list (its granted_via check is in the body).
--   4. health_consent_categories rows (S7):
--        sync_activity, sync_sleep, sync_heart, sync_body —
--          resource_type health_source, scope ingestion:<category>,
--          per_resource (resource = apple_health | health_connect | an
--          aggregator connector id), processing_active: enforced by
--          routes/health-ingest.ts (services/health-sync/adapter.ts) and
--          services/health-store/consent-gate.ts;
--        self_logged_health — resource_type health_category, scope
--          ingestion:self_logged, one consent (diary, voice and manual
--          sources, every data category), processing_active: enforced by
--          services/health-store/consent-gate.ts.
--      ON CONFLICT DO NOTHING, so a later wording-version bump is never reset.
--
-- Consent never defaults to granted: this migration inserts no consent row.
-- The legacy consent-free ingest path (health_ingest_wearable_samples) is
-- closed by VTID-05156 (20261014120000), not here; the SQL test asserts that
-- revoke is in place.
--
-- Rollback: none needed (round-3 F1) — redeploying the previous gateway
-- leaves the extra catalogue rows, connector rows and CHECK values unused.
--
-- Tests: scripts/ci/sql-tests/run-health-sync-consent-test.sh
-- (CI SQL-HEALTH-SYNC-CONSENT.yml); services/gateway/test/migrations/
-- vtid-05164-health-sync-consent-migration.test.ts.
-- =============================================================================

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.health_consent_categories') IS NULL
     OR to_regprocedure('public.fn_set_health_consent(uuid, uuid, text, text, text, text, text, text, text, uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'VTID-05164: apply 20261012180000_vtid_05092_health_consent_categories.sql first';
  END IF;
END
$pre$;

-- ===========================================================================
-- 1. connector_registry.category — superset with health_store
-- ===========================================================================
-- Dropped by definition rather than by name (same pattern as 20260419000000),
-- so a differently named copy of the old constraint cannot survive.
DO $cat$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.connector_registry'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%category%'
  LOOP
    EXECUTE format('ALTER TABLE public.connector_registry DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$cat$;
ALTER TABLE public.connector_registry
  ADD CONSTRAINT connector_registry_category_check
  CHECK (category IN ('social','wearable','shop','calendar','productivity','aggregator','ai_assistant','health_store'));

-- ===========================================================================
-- 2. connector_registry — the two phone health stores
-- ===========================================================================
INSERT INTO public.connector_registry (
  id, category, display_name, description, auth_type,
  capabilities, default_scopes, underlying_providers,
  enabled, requires_ios_companion, docs_url
) VALUES
  ('apple_health', 'health_store', 'Apple Health',
   'Apple Health (HealthKit) on the member''s iPhone, read on the device by the Vitana app and sent through Health Sync v1. No OAuth, no server-side access.',
   'sdk_bridge',
   ARRAY['activity.read','sleep.read','heart.read','body.read'],
   ARRAY[]::TEXT[],
   NULL,
   FALSE, TRUE,
   NULL),
  ('health_connect', 'health_store', 'Health Connect',
   'Health Connect on the member''s Android phone, read on the device by the Vitana app and sent through Health Sync v1. No OAuth, no server-side access.',
   'sdk_bridge',
   ARRAY['activity.read','sleep.read','heart.read','body.read'],
   ARRAY[]::TEXT[],
   NULL,
   FALSE, FALSE,
   NULL)
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 3. granted_via — superset with native_health_sync
-- ===========================================================================
DO $gv$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.data_sharing_consents'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%granted_via%'
  LOOP
    EXECUTE format('ALTER TABLE public.data_sharing_consents DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$gv$;
ALTER TABLE public.data_sharing_consents
  ADD CONSTRAINT data_sharing_consents_granted_via_check CHECK (granted_via IN (
    'checkout_flow', 'settings_connected_apps', 'portal_admin_backfill',
    'settings_privacy', 'partner_link_confirm', 'native_health_sync'
  ));

-- fn_set_health_consent: the VTID-05092 body unchanged except the granted_via
-- list (native_health_sync added). CREATE OR REPLACE keeps the ACL; the
-- REVOKE/GRANT below restate it.
CREATE OR REPLACE FUNCTION public.fn_set_health_consent(
    p_tenant uuid,
    p_user uuid,
    p_category text,
    p_resource_id text,
    p_action text,
    p_granted_via text,
    p_text_version text,
    p_locale text,
    p_actor_role text,
    p_actor_id uuid,
    p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cat       public.health_consent_categories%ROWTYPE;
  v_resource  text;
  v_row       public.data_sharing_consents%ROWTYPE;
  v_after     public.data_sharing_consents%ROWTYPE;
  v_before    jsonb;
  v_event_id  uuid;
  v_found     boolean;
BEGIN
  IF p_tenant IS NULL OR p_user IS NULL THEN
    RAISE EXCEPTION 'fn_set_health_consent: tenant and user are required';
  END IF;

  IF p_action IS NULL OR p_action NOT IN ('grant', 'revoke') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_action');
  END IF;

  SELECT * INTO v_cat FROM public.health_consent_categories WHERE key = p_category;
  IF NOT FOUND OR (p_action = 'grant' AND NOT v_cat.active) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'unknown_category');
  END IF;

  -- Resource: per partner / connector, or the category itself.
  IF v_cat.per_resource THEN
    v_resource := NULLIF(btrim(COALESCE(p_resource_id, '')), '');
    IF v_resource IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'resource_required');
    END IF;
    IF p_action = 'grant'
       AND v_cat.resource_type = 'partner_integration'
       AND NOT EXISTS (
         SELECT 1 FROM public.partner_registry pr
          WHERE pr.partner_key = v_resource
            AND pr.status IN ('active', 'sandbox')
       ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'unknown_resource');
    END IF;
  ELSE
    IF NULLIF(btrim(COALESCE(p_resource_id, '')), '') IS NOT NULL AND p_resource_id <> v_cat.key THEN
      RETURN jsonb_build_object('ok', false, 'code', 'unknown_resource');
    END IF;
    v_resource := v_cat.key;
  END IF;

  IF p_action = 'grant' THEN
    IF p_granted_via IS NULL OR p_granted_via NOT IN (
         'checkout_flow', 'settings_connected_apps', 'portal_admin_backfill',
         'settings_privacy', 'partner_link_confirm', 'native_health_sync') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'invalid_granted_via');
    END IF;
    -- The wording shown must be the current one. The single exception is the
    -- legacy partner route (no wording was ever shown there), which records
    -- 'legacy-03885' for partner_results only (owner decision 2026-10-12).
    IF p_text_version IS NULL
       OR (p_text_version <> v_cat.current_text_version
           AND NOT (p_text_version = 'legacy-03885' AND v_cat.key = 'partner_results')) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'stale_text_version');
    END IF;
  END IF;

  SELECT * INTO v_row FROM public.data_sharing_consents
   WHERE tenant_id = p_tenant AND user_id = p_user
     AND resource_type = v_cat.resource_type AND resource_id = v_resource AND scope = v_cat.scope
   FOR UPDATE;
  v_found := FOUND;

  IF p_action = 'revoke' THEN
    IF NOT v_found OR v_row.revoked_at IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'changed', false, 'action', 'revoke',
        'category', v_cat.key, 'resource_type', v_cat.resource_type, 'resource_id', v_resource, 'scope', v_cat.scope);
    END IF;
    v_before := to_jsonb(v_row);
    UPDATE public.data_sharing_consents
       SET revoked_at = NOW(),
           category_key = COALESCE(category_key, v_cat.key)
     WHERE id = v_row.id
    RETURNING * INTO v_after;
  ELSE
    IF NOT v_found THEN
      INSERT INTO public.data_sharing_consents
        (tenant_id, user_id, resource_type, resource_id, scope, granted_via, category_key, text_version, shown_locale)
      VALUES
        (p_tenant, p_user, v_cat.resource_type, v_resource, v_cat.scope, p_granted_via, v_cat.key, p_text_version, p_locale)
      ON CONFLICT (tenant_id, user_id, resource_type, resource_id, scope) DO NOTHING
      RETURNING * INTO v_after;
      IF FOUND THEN
        v_before := NULL;
      ELSE
        -- A concurrent grant inserted the row first: lock it and continue as an update.
        SELECT * INTO v_row FROM public.data_sharing_consents
         WHERE tenant_id = p_tenant AND user_id = p_user
           AND resource_type = v_cat.resource_type AND resource_id = v_resource AND scope = v_cat.scope
         FOR UPDATE;
        v_found := TRUE;
      END IF;
    END IF;

    IF v_found THEN
      IF v_row.revoked_at IS NULL
         AND v_row.text_version IS NOT DISTINCT FROM p_text_version
         AND v_row.shown_locale IS NOT DISTINCT FROM p_locale THEN
        RETURN jsonb_build_object('ok', true, 'changed', false, 'action', 'grant',
          'consent_id', v_row.id, 'category', v_cat.key, 'resource_type', v_cat.resource_type,
          'resource_id', v_resource, 'scope', v_cat.scope, 'text_version', v_row.text_version,
          'shown_locale', v_row.shown_locale, 'granted_via', v_row.granted_via,
          'granted_at', v_row.granted_at, 'revoked_at', v_row.revoked_at);
      END IF;
      v_before := to_jsonb(v_row);
      UPDATE public.data_sharing_consents
         SET revoked_at = NULL,
             granted_at = NOW(),
             granted_via = p_granted_via,
             category_key = v_cat.key,
             text_version = p_text_version,
             shown_locale = p_locale
       WHERE id = v_row.id
      RETURNING * INTO v_after;
    END IF;
  END IF;

  INSERT INTO public.data_sharing_consent_events
    (tenant_id, user_id, resource_type, resource_id, scope, action, actor_role, actor_id,
     before, after, category_key, text_version, shown_locale, request_id)
  VALUES
    (p_tenant, p_user, v_cat.resource_type, v_resource, v_cat.scope, p_action, p_actor_role, p_actor_id,
     v_before, to_jsonb(v_after), v_cat.key, v_after.text_version, p_locale, p_request_id)
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object('ok', true, 'changed', true, 'action', p_action,
    'consent_id', v_after.id, 'event_id', v_event_id, 'category', v_cat.key,
    'resource_type', v_cat.resource_type, 'resource_id', v_resource, 'scope', v_cat.scope,
    'text_version', v_after.text_version, 'shown_locale', v_after.shown_locale,
    'granted_via', v_after.granted_via, 'granted_at', v_after.granted_at, 'revoked_at', v_after.revoked_at);
END;
$$;

COMMENT ON FUNCTION public.fn_set_health_consent(uuid, uuid, text, text, text, text, text, text, text, uuid, text) IS 'VTID-05092 / VTID-05164: grant or revoke one health consent and write its data_sharing_consent_events row in the same transaction (both or neither). Validates the category, the resource (partner_registry active|sandbox on grant) and the wording version. granted_via adds native_health_sync (VTID-05164). Called only by the gateway (service_role).';

REVOKE ALL ON FUNCTION public.fn_set_health_consent(uuid, uuid, text, text, text, text, text, text, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_set_health_consent(uuid, uuid, text, text, text, text, text, text, text, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.fn_set_health_consent(uuid, uuid, text, text, text, text, text, text, text, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_set_health_consent(uuid, uuid, text, text, text, text, text, text, text, uuid, text) TO service_role;

-- ===========================================================================
-- 4. health_consent_categories — the five Phase 1 keys (S7)
-- ===========================================================================
INSERT INTO public.health_consent_categories
    (key, resource_type, scope, per_resource, current_text_version, processing_active, sort)
VALUES
    ('sync_activity',      'health_source',   'ingestion:activity',    TRUE,  'v1', TRUE, 60),
    ('sync_sleep',         'health_source',   'ingestion:sleep',       TRUE,  'v1', TRUE, 70),
    ('sync_heart',         'health_source',   'ingestion:heart',       TRUE,  'v1', TRUE, 80),
    ('sync_body',          'health_source',   'ingestion:body',        TRUE,  'v1', TRUE, 90),
    ('self_logged_health', 'health_category', 'ingestion:self_logged', FALSE, 'v1', TRUE, 100)
ON CONFLICT (key) DO NOTHING;

COMMENT ON COLUMN public.health_consent_categories.processing_active IS 'VTID-05092 / VTID-05164: true only where a fail-closed enforcement point checks this category: partner_results at partner-health ingestion (VTID-03885); sync_* at POST /api/v1/health/ingest and the health store consent gate; self_logged_health at the health store consent gate.';

-- ===========================================================================
-- 5. Refuse to apply (rolling everything back) unless the end state holds
-- ===========================================================================
DO $check$
DECLARE
  v_def text;
BEGIN
  IF (SELECT count(*) FROM public.health_consent_categories
       WHERE key IN ('sync_activity','sync_sleep','sync_heart','sync_body','self_logged_health')) <> 5 THEN
    RAISE EXCEPTION 'VTID-05164: the five Health Sync consent categories are not all present';
  END IF;
  IF (SELECT count(*) FROM public.connector_registry
       WHERE id IN ('apple_health','health_connect') AND category = 'health_store') <> 2 THEN
    RAISE EXCEPTION 'VTID-05164: apple_health / health_connect connector rows missing';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.data_sharing_consents'::regclass AND conname = 'data_sharing_consents_granted_via_check';
  IF v_def IS NULL OR v_def NOT LIKE '%native_health_sync%' OR v_def NOT LIKE '%partner_link_confirm%'
     OR v_def NOT LIKE '%settings_privacy%' OR v_def NOT LIKE '%checkout_flow%'
     OR v_def NOT LIKE '%settings_connected_apps%' OR v_def NOT LIKE '%portal_admin_backfill%' THEN
    RAISE EXCEPTION 'VTID-05164: granted_via CHECK is not the VTID-05092 superset plus native_health_sync';
  END IF;
  IF has_function_privilege('authenticated', 'public.fn_set_health_consent(uuid, uuid, text, text, text, text, text, text, text, uuid, text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_set_health_consent(uuid, uuid, text, text, text, text, text, text, text, uuid, text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05164: fn_set_health_consent must stay service_role only';
  END IF;
END
$check$;

COMMIT;
