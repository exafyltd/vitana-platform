-- Migration: 20260418000000_vtid_02200_marketplace_sources_config.sql
-- Purpose: VTID-02200 Phase 2 — admin-managed config for marketplace sync sources
--          (Shopify stores, CJ advertiser allowlists, Amazon PA-API locales).
--          Removes the need for SHOPIFY_SHOPS env JSON blobs.

CREATE TABLE IF NOT EXISTS public.marketplace_sources_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID,                                  -- NULL = platform-wide
  source_network TEXT NOT NULL
    CHECK (source_network IN ('shopify','cj','amazon','awin','rakuten','manual')),
  display_name TEXT NOT NULL,

  /*
   * Opaque JSON config per source_network. Shape examples:
   *
   * Shopify:
   *   {
   *     "domain": "acme.myshopify.com",
   *     "storefront_access_token": "...",
   *     "merchant_name": "ACME Wellness",
   *     "merchant_country": "DE",
   *     "ships_to_countries": ["DE","AT","CH","NL","FR","IT","ES","GB"],
   *     "ships_to_regions": ["EU","UK"],
   *     "commission_rate": 0.10,
   *     "affiliate_url_template": "https://acme.myshopify.com/products/{handle}?ref=vitana",
   *     "health_goals_by_collection": { "sleep": ["better-sleep"], "stress": ["stress-reduction"] },
   *     "dietary_tags_by_collection": { "vegan": ["vegan"] }
   *   }
   *
   * CJ:
   *   {
   *     "advertiser_ids": ["12345","67890"],
   *     "keywords": ["magnesium","ashwagandha"],
   *     "product_limit": 1000
   *   }
   *
   * Amazon:
   *   {
   *     "locale": "de",
   *     "associate_tag": "vitana-21",
   *     "access_key": "...",
   *     "secret_key": "...",
   *     "keywords": ["magnesium"]
   *   }
   */
  config JSONB NOT NULL,

  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_sync_at TIMESTAMPTZ,
  last_sync_status TEXT CHECK (last_sync_status IS NULL OR last_sync_status IN ('success','partial','failed')),
  last_sync_stats JSONB,
  notes TEXT,

  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketplace_sources_config_active
  ON public.marketplace_sources_config (source_network, is_active);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.marketplace_sources_config_bump_updated()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_marketplace_sources_config_updated ON public.marketplace_sources_config;
CREATE TRIGGER trg_marketplace_sources_config_updated
  BEFORE UPDATE ON public.marketplace_sources_config
  FOR EACH ROW EXECUTE FUNCTION public.marketplace_sources_config_bump_updated();

-- RLS: admins only
ALTER TABLE public.marketplace_sources_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS marketplace_sources_config_service ON public.marketplace_sources_config;
CREATE POLICY marketplace_sources_config_service ON public.marketplace_sources_config
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

COMMENT ON TABLE public.marketplace_sources_config IS
  'VTID-02200: Admin-managed config for marketplace sync sources (Shopify stores, CJ, Amazon, Awin, Rakuten). Replaces env-JSON bootstrap.';
