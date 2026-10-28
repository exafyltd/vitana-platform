-- Migration: 20260418030000_vtid_02400_vaea_phase0.sql
-- Purpose: VTID-02400 Phase 0 — Vitana Autonomous Economic Actor (VAEA) foundation.
--          Ships the config + catalog schema and the three user-facing switches
--          (receive / give / make-money goal). No loops, no listeners, no broker.
--          Those arrive in Phase 1+.
--
-- Defaults:
--   * mesh topology            = centralized broker (vaea-mesh service owned by us)
--   * mesh scope               = maxina_only
--   * commission flow          = matching-layer only (payouts ride affiliate networks)
--   * autonomy_default         = draft_to_user (user taps to send)
--   * give_recommendations     = FALSE (opt-in)
--   * receive_recommendations  = TRUE
--   * make_money_goal          = FALSE
--
-- Feature flags (GUC-style, flipped in env for Cloud Run):
--   VAEA_ENABLED, VAEA_AUTO_EXECUTE_ENABLED, VAEA_MESH_BOUNDED_NETWORK

-- ===========================================================================
-- 1. VAEA_CONFIG — per-user agent personality
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.vaea_config (
  user_id UUID NOT NULL,
  tenant_id UUID NOT NULL,

  -- Three user-facing switches
  receive_recommendations BOOLEAN NOT NULL DEFAULT TRUE,
  give_recommendations BOOLEAN NOT NULL DEFAULT FALSE,
  make_money_goal BOOLEAN NOT NULL DEFAULT FALSE,

  -- Autonomy ladder per channel
  autonomy_default TEXT NOT NULL DEFAULT 'draft_to_user'
    CHECK (autonomy_default IN ('silent','draft_to_user','one_tap_approve','auto_post')),
  autonomy_by_channel JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Voice + disclosure
  voice_samples JSONB NOT NULL DEFAULT '[]'::jsonb,
  disclosure_text TEXT NOT NULL DEFAULT
    'I earn a small commission if you use this link — happy to share non-affiliate alternatives too.',

  -- Scope + safety
  expertise_zones TEXT[] NOT NULL DEFAULT '{}',
  excluded_categories TEXT[] NOT NULL DEFAULT '{}',
  blocked_counterparties TEXT[] NOT NULL DEFAULT '{}',

  -- Rate limits
  max_replies_per_day INT NOT NULL DEFAULT 0,
  min_minutes_between_replies INT NOT NULL DEFAULT 30,

  -- Mesh participation
  mesh_scope TEXT NOT NULL DEFAULT 'maxina_only'
    CHECK (mesh_scope IN ('maxina_only','open')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_vaea_config_give
  ON public.vaea_config (tenant_id, user_id)
  WHERE give_recommendations = TRUE;

CREATE INDEX IF NOT EXISTS idx_vaea_config_goal
  ON public.vaea_config (tenant_id, user_id)
  WHERE make_money_goal = TRUE;

CREATE OR REPLACE FUNCTION public.vaea_config_bump_updated()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_vaea_config_updated ON public.vaea_config;
CREATE TRIGGER trg_vaea_config_updated
  BEFORE UPDATE ON public.vaea_config
  FOR EACH ROW EXECUTE FUNCTION public.vaea_config_bump_updated();

-- ===========================================================================
-- 2. VAEA_REFERRAL_CATALOG — user's offerable products/services + affiliate links
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.vaea_referral_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,

  -- Priority tier: own > vetted_partner > affiliate_network
  tier TEXT NOT NULL
    CHECK (tier IN ('own','vetted_partner','affiliate_network')),

  category TEXT NOT NULL,                              -- e.g. 'supplement', 'longevity-device', 'coaching'
  title TEXT NOT NULL,
  description TEXT,

  affiliate_url TEXT NOT NULL,                         -- canonical referral URL
  affiliate_network TEXT,                              -- 'amazon','impact','shareasale','iherb','direct'
  commission_percent NUMERIC(5,2),                     -- 0.00 - 100.00, null if unknown

  personal_note TEXT,                                  -- user's voice ("I've used this 6 months")
  vetting_status TEXT NOT NULL DEFAULT 'unvetted'
    CHECK (vetting_status IN ('unvetted','tried','endorsed')),

  active BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vaea_catalog_user_active
  ON public.vaea_referral_catalog (tenant_id, user_id, active)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_vaea_catalog_category
  ON public.vaea_referral_catalog (category, active)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_vaea_catalog_tier
  ON public.vaea_referral_catalog (tier, active)
  WHERE active = TRUE;

DROP TRIGGER IF EXISTS trg_vaea_catalog_updated ON public.vaea_referral_catalog;
CREATE TRIGGER trg_vaea_catalog_updated
  BEFORE UPDATE ON public.vaea_referral_catalog
  FOR EACH ROW EXECUTE FUNCTION public.vaea_config_bump_updated();

-- ===========================================================================
-- 3. RLS + GRANTS
-- ===========================================================================

ALTER TABLE public.vaea_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vaea_config_select_own ON public.vaea_config;
CREATE POLICY vaea_config_select_own ON public.vaea_config
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS vaea_config_upsert_own ON public.vaea_config;
CREATE POLICY vaea_config_upsert_own ON public.vaea_config
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS vaea_config_service ON public.vaea_config;
CREATE POLICY vaea_config_service ON public.vaea_config
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.vaea_referral_catalog ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vaea_catalog_select_own ON public.vaea_referral_catalog;
CREATE POLICY vaea_catalog_select_own ON public.vaea_referral_catalog
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS vaea_catalog_mutate_own ON public.vaea_referral_catalog;
CREATE POLICY vaea_catalog_mutate_own ON public.vaea_referral_catalog
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS vaea_catalog_service ON public.vaea_referral_catalog;
CREATE POLICY vaea_catalog_service ON public.vaea_referral_catalog
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.vaea_config TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vaea_referral_catalog TO authenticated;

-- ===========================================================================
-- 4. VTID LEDGER
-- ===========================================================================

INSERT INTO public.vtid_ledger (
  vtid, layer, module, status, title, description, summary, task_family,
  task_type, assigned_to, metadata, created_at, updated_at
) VALUES (
  'VTID-02400', 'PLATFORM', 'VAEA', 'in_progress',
  'VAEA Phase 0 — scaffold + config + catalog',
  'Vitana Autonomous Economic Actor. Phase 0 lays down the service skeleton, the three user switches (receive / give / make-money goal), the referral catalog, and feature flags. No loops, no listeners, no mesh broker yet — those arrive in Phase 1+.',
  'M2M referral agent foundation. Defaults: centralized broker, maxina-bounded, matching-layer-only. All autonomy gated behind VAEA_ENABLED=false.',
  'ECONOMIC_ACTOR',
  'scaffold',
  'platform',
  jsonb_build_object(
    'phase', 0,
    'mesh_topology', 'centralized',
    'mesh_scope_default', 'maxina_only',
    'commission_flow', 'matching_layer',
    'loops_enabled', false,
    'auto_execute_default', false,
    'tables', jsonb_build_array('vaea_config','vaea_referral_catalog'),
    'feature_flags', jsonb_build_array('VAEA_ENABLED','VAEA_AUTO_EXECUTE_ENABLED','VAEA_MESH_BOUNDED_NETWORK')
  ),
  NOW(), NOW()
)
ON CONFLICT (vtid) DO UPDATE SET
  status = EXCLUDED.status,
  description = EXCLUDED.description,
  summary = EXCLUDED.summary,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();
