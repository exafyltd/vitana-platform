-- VTID-05161 (Health Hub Phase 1 / B1, program VTID-05020) — health_sources:
-- one connection model for every place health data comes from (device clouds,
-- aggregators, phone stores, partners, and the member's own manual / voice /
-- diary logging), backfilled from the health half of user_connections
-- (category wearable/aggregator) and from user_integrations.
--
-- APPLY TARGET: Aurora only (0T; production after the cutover). Never Supabase.
-- Same placement guard as the VTID-05158 store migration: it refuses a database
-- that has both auth.users and storage.objects (Supabase) unless the session
-- sets vitana.health_store_target = 'aurora'. MIGRATION-DRIFT-CHECK lists
-- health_sources as Aurora-only (scripts/ci/migration-drift-baseline.json
-- `aurora_only_tables`) and FAILS if it ever appears on Supabase.
-- The user_integrations browser-write revoke (Change 1c) is a separate
-- migration (20261014100300_*) because it applies to Supabase.
--
-- Design (plan docs/validation/VTID-05161/plan-sparring.md, B Change 1, S6):
--   * schema public, tenant_id + user_id NOT NULL, NO foreign key to
--     auth.users: erase_user_data() finds the table by its catalogue scan.
--   * connector_id is nullable and references connector_registry(id). Phone
--     store ids (apple_health / health_connect) are registered by C1; until
--     then a phone-store source cannot be created (the gateway answers
--     STORE_UNAVAILABLE).
--   * token_ref is a pointer `user_connections:<uuid>`, never a token. Tokens
--     stay sealed in user_connections (VTID-05030).
--   * RLS: a member reads only their own rows; no browser role can INSERT,
--     UPDATE or DELETE. Writes only through the gateway (service_role).
--   * source_rank is not a column: the store derives it from kind (S2).
--   * the legacy -> source mapping below is the same one the gateway's
--     dual-write uses (services/health-sources/legacy-mirror.ts); the
--     reconcile function counts both models with it.

BEGIN;

-- 1a. Placement guard (VTID-05158 pattern).
DO $guard$
BEGIN
  IF coalesce(current_setting('vitana.health_store_target', true), '') <> 'aurora'
     AND to_regclass('auth.users') IS NOT NULL
     AND to_regclass('storage.objects') IS NOT NULL THEN
    RAISE EXCEPTION 'VTID-05161 health store placement guard: this database has auth.users and storage.objects (Supabase). health_sources is Aurora-only. On Aurora with an auth shim, SET vitana.health_store_target = ''aurora'' first.'
      USING ERRCODE = 'P0001';
  END IF;
END
$guard$;

SET LOCAL lock_timeout = '5s';

-- 1b. The table.
CREATE TABLE IF NOT EXISTS public.health_sources (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL,
  user_id                     uuid NOT NULL,
  kind                        text NOT NULL
    CONSTRAINT health_sources_kind_check
    CHECK (kind IN ('device_cloud', 'aggregator', 'phone_store', 'partner', 'manual', 'voice', 'diary')),
  connector_id                text NULL
    CONSTRAINT health_sources_connector_fk REFERENCES public.connector_registry(id),
  provider_user_id            text,
  status                      text NOT NULL
    CONSTRAINT health_sources_status_check
    CHECK (status IN ('pending', 'connected', 'paused', 'disconnected', 'error')),
  token_ref                   text NULL
    CONSTRAINT health_sources_token_ref_is_pointer
    CHECK (token_ref IS NULL OR token_ref ~ '^user_connections:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  sync_cursor                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at                timestamptz,
  last_error_code             text
    CONSTRAINT health_sources_error_code_is_code
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  connected_at                timestamptz,
  disconnected_at             timestamptz,
  legacy_user_connection_id   uuid NULL CONSTRAINT health_sources_legacy_connection_key UNIQUE,
  legacy_user_integration_id  uuid NULL CONSTRAINT health_sources_legacy_integration_key UNIQUE,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  -- Connector-based kinds name their connector; the member's own logging
  -- (manual / voice / diary) never has one; a phone store is one install.
  CONSTRAINT health_sources_connector_by_kind CHECK (
    CASE
      WHEN kind IN ('device_cloud', 'aggregator', 'phone_store') THEN connector_id IS NOT NULL
      WHEN kind IN ('manual', 'voice', 'diary') THEN connector_id IS NULL
      ELSE true
    END),
  CONSTRAINT health_sources_phone_store_install CHECK (
    kind <> 'phone_store' OR (provider_user_id IS NOT NULL AND length(provider_user_id) BETWEEN 1 AND 256))
);

CREATE UNIQUE INDEX IF NOT EXISTS health_sources_identity_key
  ON public.health_sources (tenant_id, user_id, kind, coalesce(connector_id, ''), coalesce(provider_user_id, ''));
CREATE INDEX IF NOT EXISTS health_sources_user_status_idx
  ON public.health_sources (user_id, status);

CREATE OR REPLACE FUNCTION public.health_sources_bump_updated()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$fn$;
DROP TRIGGER IF EXISTS trg_health_sources_updated ON public.health_sources;
CREATE TRIGGER trg_health_sources_updated
  BEFORE UPDATE ON public.health_sources
  FOR EACH ROW EXECUTE FUNCTION public.health_sources_bump_updated();

-- 1c. RLS and grants: own-read, gateway-only writes.
ALTER TABLE public.health_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.health_sources FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.health_sources TO authenticated;
GRANT ALL ON public.health_sources TO service_role;
DROP POLICY IF EXISTS health_sources_own_read ON public.health_sources;
CREATE POLICY health_sources_own_read ON public.health_sources FOR SELECT TO authenticated
  USING (user_id = auth.uid());

REVOKE ALL ON FUNCTION public.health_sources_bump_updated() FROM PUBLIC, anon, authenticated;

-- 1d. Legacy -> source mapping (one definition for the backfill and the
-- reconcile; the gateway mirror implements the same rules).
--   user_connections: category wearable -> device_cloud, aggregator ->
--     aggregator; is_active -> connected, inactive with disconnected_at ->
--     disconnected, inactive without (a widget flow not yet completed) -> pending.
--   user_integrations: 'manual-entry' -> manual (no connector); an id that is
--     a wearable/aggregator connector_registry row -> device_cloud/aggregator
--     with that connector; anything else is unmapped (no OAuth, no data path)
--     and is counted, never guessed. Status is copied (same vocabulary).
--   tenant for user_integrations (which has no tenant_id): the member's
--     primary user_tenants row, ordered as the gateway resolver orders it
--     (VTID-05149: is_primary desc, created_at, tenant_id).
CREATE OR REPLACE FUNCTION public.health_sources_connection_status(p_is_active boolean, p_disconnected_at timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $fn$
  SELECT CASE WHEN p_is_active THEN 'connected'
              WHEN p_disconnected_at IS NOT NULL THEN 'disconnected'
              ELSE 'pending' END
$fn$;
REVOKE ALL ON FUNCTION public.health_sources_connection_status(boolean, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.health_sources_connection_status(boolean, timestamptz) TO service_role;

-- 1e. Backfill (idempotent: ON CONFLICT DO NOTHING on either unique key).
DO $backfill$
DECLARE
  v_conn_total int; v_conn_ins int;
  v_int_total int; v_int_ins int; v_int_no_tenant int; v_int_unmapped int;
BEGIN
  SELECT count(*) INTO v_conn_total FROM public.user_connections WHERE category IN ('wearable', 'aggregator');
  WITH ins AS (
    INSERT INTO public.health_sources (
      tenant_id, user_id, kind, connector_id, provider_user_id, status, token_ref, sync_cursor,
      last_sync_at, connected_at, disconnected_at, legacy_user_connection_id)
    SELECT uc.tenant_id, uc.user_id,
           CASE uc.category WHEN 'wearable' THEN 'device_cloud' ELSE 'aggregator' END,
           uc.connector_id, uc.provider_user_id,
           public.health_sources_connection_status(uc.is_active, uc.disconnected_at),
           'user_connections:' || uc.id::text,
           coalesce(uc.sync_cursor, '{}'::jsonb),
           uc.last_sync_at, uc.connected_at, uc.disconnected_at, uc.id
      FROM public.user_connections uc
     WHERE uc.category IN ('wearable', 'aggregator')
     ORDER BY uc.created_at, uc.id
    ON CONFLICT DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO v_conn_ins FROM ins;

  SELECT count(*) INTO v_int_total FROM public.user_integrations;
  WITH src AS (
    SELECT ui.*, t.tenant_id,
           CASE WHEN ui.integration_id = 'manual-entry' THEN 'manual'
                WHEN cr.category = 'wearable' THEN 'device_cloud'
                WHEN cr.category = 'aggregator' THEN 'aggregator' END AS kind,
           CASE WHEN ui.integration_id = 'manual-entry' THEN NULL ELSE cr.id END AS connector_id
      FROM public.user_integrations ui
      LEFT JOIN LATERAL (
        SELECT ut.tenant_id FROM public.user_tenants ut
         WHERE ut.user_id = ui.user_id
         ORDER BY ut.is_primary DESC, ut.created_at, ut.tenant_id
         LIMIT 1) t ON true
      LEFT JOIN public.connector_registry cr
        ON cr.id = ui.integration_id AND cr.category IN ('wearable', 'aggregator')
  ), ins AS (
    INSERT INTO public.health_sources (
      tenant_id, user_id, kind, connector_id, provider_user_id, status,
      last_sync_at, connected_at, disconnected_at, legacy_user_integration_id)
    SELECT s.tenant_id, s.user_id, s.kind, s.connector_id, NULL, s.status,
           s.last_sync_at, s.connected_at, s.disconnected_at, s.id
      FROM src s
     WHERE s.tenant_id IS NOT NULL AND s.kind IS NOT NULL
     ORDER BY s.created_at, s.id
    ON CONFLICT DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO v_int_ins FROM ins;

  SELECT count(*) FILTER (WHERE t.tenant_id IS NULL),
         count(*) FILTER (WHERE t.tenant_id IS NOT NULL AND ui.integration_id <> 'manual-entry' AND cr.id IS NULL)
    INTO v_int_no_tenant, v_int_unmapped
    FROM public.user_integrations ui
    LEFT JOIN LATERAL (
      SELECT ut.tenant_id FROM public.user_tenants ut
       WHERE ut.user_id = ui.user_id
       ORDER BY ut.is_primary DESC, ut.created_at, ut.tenant_id
       LIMIT 1) t ON true
    LEFT JOIN public.connector_registry cr
      ON cr.id = ui.integration_id AND cr.category IN ('wearable', 'aggregator');

  RAISE NOTICE 'VTID-05161 health_sources backfill: user_connections health rows % (inserted %), user_integrations rows % (inserted %, skipped without tenant %, skipped unmapped %)',
    v_conn_total, v_conn_ins, v_int_total, v_int_ins, v_int_no_tenant, v_int_unmapped;
END
$backfill$;

-- 1f. Reconcile counts (read-only; Change 5). Counts only, no member ids.
-- mismatch.total = 0 means every health row of both legacy models has exactly
-- one linked source with the same status, and no linked source lost its row.
CREATE OR REPLACE FUNCTION public.health_sources_reconcile_counts()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  WITH conn AS (
    SELECT uc.id,
           CASE uc.category WHEN 'wearable' THEN 'device_cloud' ELSE 'aggregator' END AS kind,
           public.health_sources_connection_status(uc.is_active, uc.disconnected_at) AS status
      FROM public.user_connections uc
     WHERE uc.category IN ('wearable', 'aggregator')
  ), integ AS (
    SELECT ui.id, ui.status,
           EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.user_id = ui.user_id) AS has_tenant,
           CASE WHEN ui.integration_id = 'manual-entry' THEN 'manual'
                WHEN cr.category = 'wearable' THEN 'device_cloud'
                WHEN cr.category = 'aggregator' THEN 'aggregator' END AS kind
      FROM public.user_integrations ui
      LEFT JOIN public.connector_registry cr
        ON cr.id = ui.integration_id AND cr.category IN ('wearable', 'aggregator')
  ), src AS (
    SELECT hs.kind, hs.status, hs.legacy_user_connection_id, hs.legacy_user_integration_id
      FROM public.health_sources hs
  )
  SELECT jsonb_build_object(
    'legacy_connections', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', kind, 'status', status, 'n', n) ORDER BY kind, status)
                                      FROM (SELECT kind, status, count(*) AS n FROM conn GROUP BY 1, 2) x), '[]'::jsonb),
    'legacy_integrations', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', coalesce(kind, 'unmapped'), 'status', status, 'n', n) ORDER BY coalesce(kind, 'unmapped'), status)
                                       FROM (SELECT kind, status, count(*) AS n FROM integ GROUP BY 1, 2) x), '[]'::jsonb),
    'sources', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', kind, 'status', status, 'n', n) ORDER BY kind, status)
                           FROM (SELECT kind, status, count(*) AS n FROM src GROUP BY 1, 2) x), '[]'::jsonb),
    'mismatch', (
      SELECT jsonb_build_object(
        'connections_unlinked', c_unlinked,
        'integrations_unlinked', i_unlinked,
        'integrations_no_tenant', i_no_tenant,
        'integrations_unmapped', i_unmapped,
        'status_mismatch', s_mismatch,
        'orphaned_sources', orphaned,
        'total', c_unlinked + i_unlinked + i_no_tenant + i_unmapped + s_mismatch + orphaned)
      FROM (
        SELECT
          (SELECT count(*) FROM conn c WHERE NOT EXISTS (SELECT 1 FROM src s WHERE s.legacy_user_connection_id = c.id)) AS c_unlinked,
          (SELECT count(*) FROM integ i WHERE i.kind IS NOT NULL AND i.has_tenant
              AND NOT EXISTS (SELECT 1 FROM src s WHERE s.legacy_user_integration_id = i.id)) AS i_unlinked,
          (SELECT count(*) FROM integ i WHERE NOT i.has_tenant
              AND NOT EXISTS (SELECT 1 FROM src s WHERE s.legacy_user_integration_id = i.id)) AS i_no_tenant,
          (SELECT count(*) FROM integ i WHERE i.kind IS NULL AND i.has_tenant
              AND NOT EXISTS (SELECT 1 FROM src s WHERE s.legacy_user_integration_id = i.id)) AS i_unmapped,
          ((SELECT count(*) FROM conn c JOIN src s ON s.legacy_user_connection_id = c.id WHERE s.status <> c.status)
           + (SELECT count(*) FROM integ i JOIN src s ON s.legacy_user_integration_id = i.id WHERE s.status <> i.status)) AS s_mismatch,
          ((SELECT count(*) FROM src s WHERE s.legacy_user_connection_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM public.user_connections uc WHERE uc.id = s.legacy_user_connection_id))
           + (SELECT count(*) FROM src s WHERE s.legacy_user_integration_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM public.user_integrations ui WHERE ui.id = s.legacy_user_integration_id))) AS orphaned
      ) m),
    'computed_at', now())
$fn$;
REVOKE ALL ON FUNCTION public.health_sources_reconcile_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.health_sources_reconcile_counts() TO service_role;

COMMENT ON TABLE public.health_sources IS
  'VTID-05161: one connection model for health data sources (S6). Backfilled from user_connections (wearable/aggregator) and user_integrations. token_ref is a pointer, never a token. Own-read RLS, gateway-only writes. Aurora only.';
COMMENT ON FUNCTION public.health_sources_reconcile_counts() IS
  'VTID-05161: counts of the legacy connection models and health_sources per kind/status plus mismatch counts (no member ids). service_role only.';

COMMIT;
