-- =============================================================================
-- BOOTSTRAP-AWARENESS-REGISTRY
-- Date: 2026-04-21
--
-- Stores admin-controlled overrides for the Awareness Registry. Each row keys
-- one signal in services/gateway/src/services/awareness-registry.ts manifest.
-- Missing rows fall back to manifest defaults (`enabled: default_on`).
--
-- v1: GLOBAL config — one row per key, applies to every tenant.
-- (Per-tenant + per-user overrides are deferred to v2.)
--
-- Access: read = exafy_admin only via RLS. Writes go through the gateway with
-- service-role key, so no INSERT/UPDATE policies are needed for end users.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.awareness_config_audit;
--   DROP TABLE IF EXISTS public.awareness_config;
-- =============================================================================

BEGIN;

-- 1. Live config table -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.awareness_config (
  key        text        PRIMARY KEY,
  enabled    boolean     NOT NULL,
  params     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.awareness_config IS
  'BOOTSTRAP-AWARENESS-REGISTRY: per-signal admin overrides. Empty rows = manifest defaults apply.';

-- 2. Audit log ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.awareness_config_audit (
  id           bigserial PRIMARY KEY,
  key          text        NOT NULL,
  prev_enabled boolean,
  new_enabled  boolean,
  prev_params  jsonb,
  new_params   jsonb,
  changed_by   uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_awareness_audit_changed_at
  ON public.awareness_config_audit (changed_at DESC);

COMMENT ON TABLE public.awareness_config_audit IS
  'BOOTSTRAP-AWARENESS-REGISTRY: change history for awareness_config (who toggled what, when).';

-- 3. RLS — exafy admins only -------------------------------------------------
ALTER TABLE public.awareness_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.awareness_config_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS awareness_config_admin_read ON public.awareness_config;
CREATE POLICY awareness_config_admin_read
  ON public.awareness_config FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.app_users u
    WHERE u.user_id = auth.uid() AND u.exafy_admin = true
  ));

DROP POLICY IF EXISTS awareness_audit_admin_read ON public.awareness_config_audit;
CREATE POLICY awareness_audit_admin_read
  ON public.awareness_config_audit FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.app_users u
    WHERE u.user_id = auth.uid() AND u.exafy_admin = true
  ));

-- Service role bypasses RLS entirely, so the gateway can write without policies.

COMMIT;
