-- VTID-05092 — Health Hub Phase 0 / D10, WP1: per-category, revocable,
-- auditable health consent (backend foundation).
--
-- Extends the VTID-03885 consent primitive (data_sharing_consents +
-- data_sharing_consent_events) instead of building the Phase 1
-- health_consents store:
--   1. health_consent_categories — the catalogue, kept as data.
--   2. data_sharing_consents gains category_key / text_version / shown_locale
--      and two more granted_via values.
--   3. data_sharing_consent_events gains the same three columns plus
--      request_id, and becomes append-only for real (trigger + revokes).
--   4. Browser roles lose INSERT/UPDATE/DELETE on both consent tables.
--   5. fn_set_health_consent() writes the consent AND its audit row in one
--      transaction (the gateway used to write them as two statements and
--      ignored the audit insert's error).
--   6. partner_health_result_inbox.consent_order_id, so a consent_missing row
--      can later be released to the order it belongs to (used by WP3).
--
-- Additive: no table, column or row is dropped. The only DROP statements
-- replace the granted_via CHECK (wider value list) and make the trigger
-- re-creatable. Existing consent rows keep NULL in the new columns, meaning
-- "granted under the VTID-03885 dialog, no recorded wording"; they stay valid
-- (owner decision 2026-10-12: legacy DoctorBox grants are kept).
--
-- Consent never defaults to granted: no column in this migration has a
-- default that grants anything, and the catalogue has no default-on flag.
-- The gateway works with and without this migration (fails closed without).

-- ===========================================================================
-- 1. health_consent_categories — the catalogue (data, not code)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.health_consent_categories (
    key TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*$'),
    resource_type TEXT NOT NULL
        CHECK (resource_type IN ('health_category', 'partner_integration', 'health_source')),
    scope TEXT NOT NULL CHECK (length(btrim(scope)) > 0),
    per_resource BOOLEAN NOT NULL DEFAULT FALSE,
    current_text_version TEXT NOT NULL CHECK (length(btrim(current_text_version)) > 0),
    processing_active BOOLEAN NOT NULL DEFAULT FALSE,
    sort INT NOT NULL DEFAULT 100,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.health_consent_categories IS 'VTID-05092: catalogue of health consent categories (GDPR Art. 9(2)(a) explicit consent). A category maps to (resource_type, scope) in data_sharing_consents; per_resource = one consent per partner_key / connector id, otherwise resource_id = the category key. current_text_version names the versioned consent wording the app must show for a grant. processing_active = true only where an enforcement point checks this category. There is no default-on flag: consent never defaults to granted.';
COMMENT ON COLUMN public.health_consent_categories.per_resource IS 'VTID-05092: true = the member consents per partner (partner_registry.partner_key) or per connector id; false = one consent, stored with resource_id = key.';
COMMENT ON COLUMN public.health_consent_categories.current_text_version IS 'VTID-05092: the consent wording version a grant must carry. New wording = a new version (data fix-up migration), never an edited released text.';
COMMENT ON COLUMN public.health_consent_categories.processing_active IS 'VTID-05092: true only where a fail-closed enforcement point checks this category. VTID-05092 itself adds none; partner_results is checked at partner-health ingestion since VTID-03885.';

-- Seeds. ON CONFLICT DO NOTHING so a later version bump is never reset by a
-- re-run. partner_results matches the existing DoctorBox rows unchanged
-- (partner_integration / result_ingestion / resource_id = partner_key).
INSERT INTO public.health_consent_categories
    (key, resource_type, scope, per_resource, current_text_version, processing_active, sort)
VALUES
    ('wearables',             'health_source',       'ingestion',        TRUE,  'v1', FALSE, 10),
    ('partner_results',       'partner_integration', 'result_ingestion', TRUE,  'v1', TRUE,  20),
    ('ai_health_analysis',    'health_category',     'processing',       FALSE, 'v1', FALSE, 30),
    ('health_data_analytics', 'health_category',     'processing',       FALSE, 'v1', FALSE, 40),
    ('community_insights',    'health_category',     'processing',       FALSE, 'v1', FALSE, 50)
ON CONFLICT (key) DO NOTHING;

-- Non-sensitive reference data, readable by any signed-in member (like
-- partner_registry). No browser role writes it.
ALTER TABLE public.health_consent_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS health_consent_categories_select ON public.health_consent_categories;
CREATE POLICY health_consent_categories_select ON public.health_consent_categories
    FOR SELECT TO authenticated USING (true);
REVOKE ALL ON TABLE public.health_consent_categories FROM anon, authenticated;
GRANT SELECT ON TABLE public.health_consent_categories TO authenticated;
GRANT SELECT ON TABLE public.health_consent_categories TO service_role;

-- ===========================================================================
-- 2. data_sharing_consents — wording version + locale, wider granted_via
-- ===========================================================================

ALTER TABLE public.data_sharing_consents
    ADD COLUMN IF NOT EXISTS category_key TEXT REFERENCES public.health_consent_categories(key),
    ADD COLUMN IF NOT EXISTS text_version TEXT,
    ADD COLUMN IF NOT EXISTS shown_locale TEXT;

COMMENT ON COLUMN public.data_sharing_consents.category_key IS 'VTID-05092: health_consent_categories.key. NULL on rows granted before VTID-05092.';
COMMENT ON COLUMN public.data_sharing_consents.text_version IS 'VTID-05092: consent wording version the member granted. NULL = granted under the VTID-03885 dialog with no recorded wording; ''legacy-03885'' = granted through the legacy /api/v1/partner-health/consent route.';
COMMENT ON COLUMN public.data_sharing_consents.shown_locale IS 'VTID-05092: locale of the wording the app actually displayed for the latest grant.';

-- Replace the granted_via CHECK with a wider list (existing values kept).
-- Dropped by definition rather than by name, so a differently named copy of
-- the old constraint cannot survive and keep rejecting the new values.
DO $$
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
END $$;
ALTER TABLE public.data_sharing_consents
    ADD CONSTRAINT data_sharing_consents_granted_via_check CHECK (granted_via IN (
        'checkout_flow', 'settings_connected_apps', 'portal_admin_backfill',
        'settings_privacy', 'partner_link_confirm'
    ));

-- ===========================================================================
-- 3. data_sharing_consent_events — same columns + request id, append-only
-- ===========================================================================

ALTER TABLE public.data_sharing_consent_events
    ADD COLUMN IF NOT EXISTS category_key TEXT,
    ADD COLUMN IF NOT EXISTS text_version TEXT,
    ADD COLUMN IF NOT EXISTS shown_locale TEXT,
    ADD COLUMN IF NOT EXISTS request_id TEXT;

COMMENT ON COLUMN public.data_sharing_consent_events.category_key IS 'VTID-05092: health_consent_categories.key of the consent this event changed.';
COMMENT ON COLUMN public.data_sharing_consent_events.text_version IS 'VTID-05092: wording version granted (grant) or held at revocation (revoke).';
COMMENT ON COLUMN public.data_sharing_consent_events.shown_locale IS 'VTID-05092: locale of the wording the app displayed. Audit: category_key + text_version + shown_locale -> the locked wording in vitana-v1 (src/i18n/health-consent-texts.lock.json).';
COMMENT ON COLUMN public.data_sharing_consent_events.request_id IS 'VTID-05092: the gateway request id that caused the event.';

-- Append-only, enforced: every UPDATE raises. DELETE is not blocked by a
-- trigger because erase_user_data() (VTID-04765) deletes this table directly
-- as a SECURITY DEFINER owner function; the DELETE revoke below keeps every
-- API role out instead.
CREATE OR REPLACE FUNCTION public.fn_data_sharing_consent_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'data_sharing_consent_events is append-only (VTID-05092): % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS trg_data_sharing_consent_events_append_only ON public.data_sharing_consent_events;
CREATE TRIGGER trg_data_sharing_consent_events_append_only
    BEFORE UPDATE ON public.data_sharing_consent_events
    FOR EACH ROW EXECUTE FUNCTION public.fn_data_sharing_consent_events_append_only();

COMMENT ON TABLE public.data_sharing_consent_events IS 'VTID-03885 / VTID-05092: append-only audit trail for data_sharing_consents, written in the same transaction as the consent by fn_set_health_consent(). UPDATE raises (trigger); UPDATE/DELETE/TRUNCATE are revoked from every API role. Rows are removed only by erase_user_data() on account erasure.';

-- ===========================================================================
-- 4. Revoke browser writes (defense in depth)
-- ===========================================================================
-- RLS is enabled on both tables with SELECT-only policies, so anon and
-- authenticated writes are ALREADY denied today; these revokes are defense in
-- depth (they keep a future permissive policy from opening writes) and break
-- no caller: every consent write goes through the gateway's service-role
-- client and, since VTID-05092, through fn_set_health_consent() only.
-- TRUNCATE is revoked too because it bypasses row triggers.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.data_sharing_consents FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.data_sharing_consent_events FROM anon, authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.data_sharing_consent_events FROM service_role;

-- ===========================================================================
-- 5. fn_set_health_consent — consent + audit row in ONE transaction
-- ===========================================================================
-- Returns { ok: true, changed, action, consent_id, event_id, category,
-- resource_type, resource_id, scope, text_version, shown_locale, granted_via,
-- granted_at, revoked_at } or { ok: false, code } with code in
-- unknown_category | resource_required | unknown_resource | invalid_action |
-- invalid_granted_via | stale_text_version. Idempotent: granting an active
-- consent with the same text_version and locale, or revoking an inactive or
-- missing one, changes nothing and writes no event (changed = false).
-- A revoke never validates the partner's current status: a member can always
-- withdraw, even from a partner that has since been disabled.
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
         'settings_privacy', 'partner_link_confirm') THEN
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

COMMENT ON FUNCTION public.fn_set_health_consent(uuid, uuid, text, text, text, text, text, text, text, uuid, text) IS 'VTID-05092: grant or revoke one health consent and write its data_sharing_consent_events row in the same transaction (both or neither). Validates the category, the resource (partner_registry active|sandbox on grant) and the wording version. Called only by the gateway (service_role).';

REVOKE ALL ON FUNCTION public.fn_set_health_consent(uuid, uuid, text, text, text, text, text, text, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_set_health_consent(uuid, uuid, text, text, text, text, text, text, text, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.fn_set_health_consent(uuid, uuid, text, text, text, text, text, text, text, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_set_health_consent(uuid, uuid, text, text, text, text, text, text, text, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.fn_data_sharing_consent_events_append_only() FROM PUBLIC;

-- ===========================================================================
-- 6. partner_health_result_inbox.consent_order_id (release target, WP3)
-- ===========================================================================

ALTER TABLE public.partner_health_result_inbox
    ADD COLUMN IF NOT EXISTS consent_order_id UUID REFERENCES public.partner_health_test_orders(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.partner_health_result_inbox.consent_order_id IS 'VTID-05092: for reason = consent_missing, the order the quarantined result belongs to, so it can be released once the member grants partner_results consent. NULL on rows from before VTID-05092 (released by staff upload-result).';
