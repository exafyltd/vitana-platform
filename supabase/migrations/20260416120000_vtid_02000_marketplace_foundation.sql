-- Migration: 20260416120000_vtid_02000_marketplace_foundation.sql
-- Purpose: VTID-02000 Marketplace foundation — merchants, products, user limitations,
--          condition knowledge base, outcome feedback, geo policies, feed defaults,
--          click/order tracking, vocabularies, waitlist.
--
-- This is the substrate for the Discover marketplace. The existing products_catalog
-- and services_catalog from VTID-01092 remain for backward compatibility — this
-- migration introduces a richer `products` + `merchants` model sized for scraped
-- affiliate inventory with geo-matching, outcome feedback, and user limitations.
--
-- Dependencies:
--   VTID-01092 (services_catalog / products_catalog / usage_outcomes)
--   VTID-01101 (app_users + current_tenant_id helper)
--   pgvector extension (used by memory_facts + calendar; extended here for product embeddings)

-- ===========================================================================
-- 0. EXTENSIONS
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ===========================================================================
-- 1. REGION GROUP HELPER — ISO country_code -> region_group
--    Used by: products, merchants, users, geo_policy, default_feed_config
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.get_region_group(p_country_code CHAR(2))
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE UPPER(COALESCE(p_country_code, ''))
    -- EU-27
    WHEN 'AT' THEN 'EU' WHEN 'BE' THEN 'EU' WHEN 'BG' THEN 'EU' WHEN 'HR' THEN 'EU'
    WHEN 'CY' THEN 'EU' WHEN 'CZ' THEN 'EU' WHEN 'DK' THEN 'EU' WHEN 'EE' THEN 'EU'
    WHEN 'FI' THEN 'EU' WHEN 'FR' THEN 'EU' WHEN 'DE' THEN 'EU' WHEN 'GR' THEN 'EU'
    WHEN 'HU' THEN 'EU' WHEN 'IE' THEN 'EU' WHEN 'IT' THEN 'EU' WHEN 'LV' THEN 'EU'
    WHEN 'LT' THEN 'EU' WHEN 'LU' THEN 'EU' WHEN 'MT' THEN 'EU' WHEN 'NL' THEN 'EU'
    WHEN 'PL' THEN 'EU' WHEN 'PT' THEN 'EU' WHEN 'RO' THEN 'EU' WHEN 'SK' THEN 'EU'
    WHEN 'SI' THEN 'EU' WHEN 'ES' THEN 'EU' WHEN 'SE' THEN 'EU'
    -- EFTA / near-EU
    WHEN 'NO' THEN 'EU' WHEN 'IS' THEN 'EU' WHEN 'CH' THEN 'EU' WHEN 'LI' THEN 'EU'
    -- UK (post-Brexit, separate)
    WHEN 'GB' THEN 'UK' WHEN 'UK' THEN 'UK'
    -- North America
    WHEN 'US' THEN 'US'
    WHEN 'CA' THEN 'CA'
    -- LATAM
    WHEN 'MX' THEN 'LATAM' WHEN 'BR' THEN 'LATAM' WHEN 'AR' THEN 'LATAM' WHEN 'CL' THEN 'LATAM'
    WHEN 'CO' THEN 'LATAM' WHEN 'PE' THEN 'LATAM' WHEN 'UY' THEN 'LATAM' WHEN 'EC' THEN 'LATAM'
    WHEN 'VE' THEN 'LATAM' WHEN 'PY' THEN 'LATAM' WHEN 'BO' THEN 'LATAM' WHEN 'CR' THEN 'LATAM'
    WHEN 'PA' THEN 'LATAM' WHEN 'GT' THEN 'LATAM' WHEN 'DO' THEN 'LATAM' WHEN 'HN' THEN 'LATAM'
    WHEN 'SV' THEN 'LATAM' WHEN 'NI' THEN 'LATAM' WHEN 'CU' THEN 'LATAM' WHEN 'PR' THEN 'LATAM'
    -- MENA
    WHEN 'AE' THEN 'MENA' WHEN 'SA' THEN 'MENA' WHEN 'QA' THEN 'MENA' WHEN 'KW' THEN 'MENA'
    WHEN 'BH' THEN 'MENA' WHEN 'OM' THEN 'MENA' WHEN 'JO' THEN 'MENA' WHEN 'LB' THEN 'MENA'
    WHEN 'EG' THEN 'MENA' WHEN 'IL' THEN 'MENA' WHEN 'TR' THEN 'MENA' WHEN 'MA' THEN 'MENA'
    WHEN 'TN' THEN 'MENA' WHEN 'DZ' THEN 'MENA' WHEN 'IQ' THEN 'MENA' WHEN 'IR' THEN 'MENA'
    WHEN 'SY' THEN 'MENA' WHEN 'YE' THEN 'MENA' WHEN 'LY' THEN 'MENA'
    -- APAC — split by logistics reality
    WHEN 'JP' THEN 'APAC_JP_KR_TW' WHEN 'KR' THEN 'APAC_JP_KR_TW' WHEN 'TW' THEN 'APAC_JP_KR_TW'
    WHEN 'CN' THEN 'APAC_CN' WHEN 'HK' THEN 'APAC_CN' WHEN 'MO' THEN 'APAC_CN'
    WHEN 'SG' THEN 'APAC_SEA' WHEN 'MY' THEN 'APAC_SEA' WHEN 'TH' THEN 'APAC_SEA'
    WHEN 'ID' THEN 'APAC_SEA' WHEN 'PH' THEN 'APAC_SEA' WHEN 'VN' THEN 'APAC_SEA'
    WHEN 'MM' THEN 'APAC_SEA' WHEN 'KH' THEN 'APAC_SEA' WHEN 'LA' THEN 'APAC_SEA'
    WHEN 'BN' THEN 'APAC_SEA'
    WHEN 'IN' THEN 'APAC_IN' WHEN 'PK' THEN 'APAC_IN' WHEN 'BD' THEN 'APAC_IN'
    WHEN 'LK' THEN 'APAC_IN' WHEN 'NP' THEN 'APAC_IN' WHEN 'BT' THEN 'APAC_IN'
    -- Oceania
    WHEN 'AU' THEN 'OCEANIA' WHEN 'NZ' THEN 'OCEANIA' WHEN 'FJ' THEN 'OCEANIA'
    WHEN 'PG' THEN 'OCEANIA'
    -- Africa (sub-Saharan)
    WHEN 'ZA' THEN 'AFRICA' WHEN 'NG' THEN 'AFRICA' WHEN 'KE' THEN 'AFRICA'
    WHEN 'GH' THEN 'AFRICA' WHEN 'ET' THEN 'AFRICA' WHEN 'UG' THEN 'AFRICA'
    WHEN 'TZ' THEN 'AFRICA' WHEN 'RW' THEN 'AFRICA' WHEN 'SN' THEN 'AFRICA'
    WHEN 'CI' THEN 'AFRICA' WHEN 'CM' THEN 'AFRICA' WHEN 'ZW' THEN 'AFRICA'
    ELSE 'OTHER'
  END;
$$;

COMMENT ON FUNCTION public.get_region_group(CHAR(2)) IS
  'VTID-02000: Maps ISO 3166-1 alpha-2 country code to a logistics/region group used for catalog filtering.';

-- ===========================================================================
-- 2. APP_USERS EXTENSIONS — geo, lifecycle, currency, scope preference
-- ===========================================================================

ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS country_code CHAR(2),
  ADD COLUMN IF NOT EXISTS delivery_country_code CHAR(2),
  ADD COLUMN IF NOT EXISTS region_group TEXT,
  ADD COLUMN IF NOT EXISTS locale TEXT,
  ADD COLUMN IF NOT EXISTS currency_preference CHAR(3),
  ADD COLUMN IF NOT EXISTS product_scope_preference TEXT
    CHECK (product_scope_preference IS NULL OR product_scope_preference IN ('local','regional','friendly','international')),
  ADD COLUMN IF NOT EXISTS lifecycle_stage TEXT
    CHECK (lifecycle_stage IS NULL OR lifecycle_stage IN ('onboarding','early','established','mature')),
  ADD COLUMN IF NOT EXISTS lifecycle_stage_updated_at TIMESTAMPTZ;

-- Trigger: whenever country_code or delivery_country_code changes, recompute region_group.
CREATE OR REPLACE FUNCTION public.app_users_derive_region_group()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.region_group := public.get_region_group(
    COALESCE(NEW.delivery_country_code, NEW.country_code)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_app_users_region_group ON public.app_users;
CREATE TRIGGER trg_app_users_region_group
  BEFORE INSERT OR UPDATE OF country_code, delivery_country_code ON public.app_users
  FOR EACH ROW
  EXECUTE FUNCTION public.app_users_derive_region_group();

CREATE INDEX IF NOT EXISTS idx_app_users_region_group ON public.app_users (region_group)
  WHERE region_group IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_app_users_lifecycle_stage ON public.app_users (lifecycle_stage)
  WHERE lifecycle_stage IS NOT NULL;

-- ===========================================================================
-- 3. MERCHANTS — global (not tenant-scoped), source-of-truth for product suppliers
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.merchants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  name TEXT NOT NULL CHECK (name != ''),
  slug TEXT UNIQUE,
  storefront_url TEXT,

  source_network TEXT NOT NULL,                    -- 'cj','amazon','shopify','awin','rakuten','direct_scrape','manual','partner'
  source_merchant_id TEXT,                         -- ID as known to the source network (nullable for manual)

  merchant_country CHAR(2),                        -- where the warehouse sits
  merchant_region TEXT,                            -- derived via trigger
  ships_to_countries CHAR(2)[],                    -- explicit allow-list
  ships_to_regions TEXT[],                         -- shortcut when merchant ships broadly

  currencies TEXT[] NOT NULL DEFAULT '{}',
  avg_delivery_days_eu INT,
  avg_delivery_days_us INT,
  avg_delivery_days_mena INT,

  affiliate_network TEXT,                          -- which network to postback against
  commission_rate NUMERIC(5,4),                    -- 0.0000 .. 1.0000
  quality_score SMALLINT DEFAULT 50 CHECK (quality_score BETWEEN 0 AND 100),
  customs_risk TEXT CHECK (customs_risk IS NULL OR customs_risk IN ('low','medium','high','unknown')),

  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  requires_admin_review BOOLEAN NOT NULL DEFAULT FALSE,
  admin_notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (source_network, source_merchant_id)
);

CREATE OR REPLACE FUNCTION public.merchants_derive_region()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.merchant_region := public.get_region_group(NEW.merchant_country);
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_merchants_region ON public.merchants;
CREATE TRIGGER trg_merchants_region
  BEFORE INSERT OR UPDATE ON public.merchants
  FOR EACH ROW
  EXECUTE FUNCTION public.merchants_derive_region();

CREATE INDEX IF NOT EXISTS idx_merchants_active ON public.merchants (is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_merchants_source ON public.merchants (source_network, source_merchant_id);
CREATE INDEX IF NOT EXISTS idx_merchants_region ON public.merchants (merchant_region);
CREATE INDEX IF NOT EXISTS idx_merchants_review ON public.merchants (requires_admin_review) WHERE requires_admin_review = TRUE;

-- ===========================================================================
-- 4. PRODUCTS — global marketplace catalog with rich search + geo + health fields
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,

  -- Source tracking
  source_network TEXT NOT NULL,                    -- denormalized for fast filter
  source_product_id TEXT NOT NULL,                 -- stable ID from source: ASIN, Shopify GID, CJ advertiser-product-id, URL hash
  gtin TEXT, sku TEXT, asin TEXT,                  -- cross-source dedup keys

  -- Core fields
  title TEXT NOT NULL CHECK (title != ''),
  description TEXT,
  brand TEXT,
  category TEXT,
  subcategory TEXT,
  topic_keys TEXT[] NOT NULL DEFAULT '{}',         -- tie to user_topic_profile

  -- Price
  price_cents INT,
  currency CHAR(3),
  compare_at_price_cents INT,

  -- Media
  images TEXT[] NOT NULL DEFAULT '{}',

  -- Purchase
  affiliate_url TEXT NOT NULL,
  availability TEXT NOT NULL DEFAULT 'in_stock'
    CHECK (availability IN ('in_stock','out_of_stock','preorder','discontinued','unknown')),
  rating NUMERIC(3,2),
  review_count INT,

  -- Geo
  origin_country CHAR(2),
  origin_region TEXT,                              -- derived via trigger
  ships_to_countries CHAR(2)[],                    -- explicit allow-list, falls back to merchant's
  ships_to_regions TEXT[],
  excluded_from_regions TEXT[] NOT NULL DEFAULT '{}',  -- explicit deny-list
  customs_risk TEXT CHECK (customs_risk IS NULL OR customs_risk IN ('low','medium','high','unknown')),

  -- Search + personalization fields
  health_goals TEXT[] NOT NULL DEFAULT '{}',       -- ['better-sleep','stress-reduction','muscle-recovery','focus']
  dietary_tags TEXT[] NOT NULL DEFAULT '{}',       -- ['vegan','gluten-free','halal','kosher']
  form TEXT,                                        -- 'capsule','tablet','powder','liquid','gummy','softgel','spray','other'
  certifications TEXT[] NOT NULL DEFAULT '{}',
  ingredients_primary TEXT[] NOT NULL DEFAULT '{}',-- flattened top ingredients for fast filter
  target_audience TEXT[] NOT NULL DEFAULT '{}',
  contains_allergens TEXT[] NOT NULL DEFAULT '{}', -- for limitations-filter hard check
  contraindicated_with_conditions TEXT[] NOT NULL DEFAULT '{}',
  contraindicated_with_medications TEXT[] NOT NULL DEFAULT '{}',

  embedding VECTOR(1536),                          -- populated by async job (Phase 2)
  search_text TSVECTOR
    GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', COALESCE(title,'')), 'A') ||
      setweight(to_tsvector('simple', COALESCE(brand,'')), 'A') ||
      setweight(to_tsvector('simple', COALESCE(array_to_string(ingredients_primary,' '),'')), 'B') ||
      setweight(to_tsvector('simple', COALESCE(array_to_string(health_goals,' '),'')), 'B') ||
      setweight(to_tsvector('simple', COALESCE(description,'')), 'C')
    ) STORED,

  -- Reward system integration (nullable — reward system populates later)
  reward_preview JSONB,                            -- e.g. {"points_estimate": 120, "currency": "VTP"}

  -- Ingestion metadata
  raw JSONB,                                        -- full original source payload
  content_hash TEXT,                                -- SHA256 of canonical fields for drift detection
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- stale > 30d triggers auto-deactivate

  -- Status + moderation
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  requires_admin_review BOOLEAN NOT NULL DEFAULT FALSE,
  admin_review_reason TEXT,
  analyzer_confidence NUMERIC(4,3),                 -- 0..1 from the marketplace-analyzer
  admin_notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (source_network, source_product_id)
);

CREATE OR REPLACE FUNCTION public.products_derive_region()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.origin_region := public.get_region_group(NEW.origin_country);
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_region ON public.products;
CREATE TRIGGER trg_products_region
  BEFORE INSERT OR UPDATE ON public.products
  FOR EACH ROW
  EXECUTE FUNCTION public.products_derive_region();

CREATE INDEX IF NOT EXISTS idx_products_active_category ON public.products (category, subcategory, is_active)
  WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_products_merchant ON public.products (merchant_id);
CREATE INDEX IF NOT EXISTS idx_products_ships_countries ON public.products USING GIN (ships_to_countries);
CREATE INDEX IF NOT EXISTS idx_products_ships_regions ON public.products USING GIN (ships_to_regions);
CREATE INDEX IF NOT EXISTS idx_products_origin_region ON public.products (origin_region);
CREATE INDEX IF NOT EXISTS idx_products_topic_keys ON public.products USING GIN (topic_keys);
CREATE INDEX IF NOT EXISTS idx_products_health_goals ON public.products USING GIN (health_goals);
CREATE INDEX IF NOT EXISTS idx_products_dietary_tags ON public.products USING GIN (dietary_tags);
CREATE INDEX IF NOT EXISTS idx_products_ingredients_primary ON public.products USING GIN (ingredients_primary);
CREATE INDEX IF NOT EXISTS idx_products_contains_allergens ON public.products USING GIN (contains_allergens);
CREATE INDEX IF NOT EXISTS idx_products_search_text ON public.products USING GIN (search_text);
CREATE INDEX IF NOT EXISTS idx_products_last_seen ON public.products (last_seen_at);
CREATE INDEX IF NOT EXISTS idx_products_review_queue ON public.products (requires_admin_review)
  WHERE requires_admin_review = TRUE AND is_active = TRUE;

-- Embedding index (ivfflat) — lists=100 is a reasonable starter for <1M rows.
-- Will only work once rows exist + VACUUM ANALYZE run; safe to create empty.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_products_embedding'
  ) THEN
    BEGIN
      EXECUTE 'CREATE INDEX idx_products_embedding ON public.products USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)';
    EXCEPTION WHEN OTHERS THEN
      -- ivfflat requires pgvector; tolerate if unavailable
      RAISE NOTICE 'Skipping ivfflat index: %', SQLERRM;
    END;
  END IF;
END $$;

-- ===========================================================================
-- 5. TENANT CATALOG OVERRIDES — per-tenant hide list for the shared product catalog
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.tenant_catalog_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('product','merchant','category','subcategory','brand')),
  target_ref TEXT NOT NULL,                        -- UUID or text value depending on target_type
  action TEXT NOT NULL CHECK (action IN ('hide','require_approval','feature')),
  reason TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, target_type, target_ref, action)
);

CREATE INDEX IF NOT EXISTS idx_tenant_catalog_overrides_lookup
  ON public.tenant_catalog_overrides (tenant_id, target_type, action);

-- ===========================================================================
-- 6. CATALOG SOURCES — ingestion run provenance
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.catalog_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_network TEXT NOT NULL,                    -- 'cj','scrape:amazon.de','shopify:partner-store-slug',...
  source_url TEXT,
  run_id UUID NOT NULL DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  products_inserted INT DEFAULT 0,
  products_updated INT DEFAULT 0,
  products_skipped INT DEFAULT 0,
  errors INT DEFAULT 0,
  triggered_by TEXT,                                -- 'claude_code','cron_cj_daily','manual_admin','marketplace_curator_agent'
  notes TEXT,
  error_sample JSONB,                               -- sample of error payloads
  UNIQUE (run_id)
);

CREATE INDEX IF NOT EXISTS idx_catalog_sources_network_time
  ON public.catalog_sources (source_network, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_catalog_sources_active
  ON public.catalog_sources (started_at DESC)
  WHERE finished_at IS NULL;

-- ===========================================================================
-- 7. GEO POLICY — exclusion rules per region pair (editable via admin UI)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.geo_policy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_region TEXT NOT NULL,                       -- e.g. 'EU'
  rule_type TEXT NOT NULL CHECK (rule_type IN ('exclude_origin','prefer_origin','require_tag','require_certification')),
  applies_to_origin TEXT,                          -- e.g. 'APAC_CN'
  applies_to_tag TEXT,
  weight NUMERIC(5,2) NOT NULL DEFAULT 0,          -- negative = exclude strength; positive = boost
  user_opt_out_scope TEXT,                          -- when user has product_scope_preference = this, rule is bypassed; null = always apply
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_geo_policy_user_region
  ON public.geo_policy (user_region, is_active);

-- ===========================================================================
-- 8. USER LIMITATIONS — non-negotiable filter substrate
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.user_limitations (
  user_id UUID PRIMARY KEY REFERENCES public.app_users(user_id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,

  allergies TEXT[] NOT NULL DEFAULT '{}',
  dietary_restrictions TEXT[] NOT NULL DEFAULT '{}',
  contraindications TEXT[] NOT NULL DEFAULT '{}',
  current_medications TEXT[] NOT NULL DEFAULT '{}',
  pregnancy_status TEXT
    CHECK (pregnancy_status IS NULL OR pregnancy_status IN ('not_pregnant','pregnant','nursing','prefer_not_say','unknown')),
  age_bracket TEXT
    CHECK (age_bracket IS NULL OR age_bracket IN ('child','teen','adult','senior')),
  religious_restrictions TEXT[] NOT NULL DEFAULT '{}',
  ingredient_sensitivities TEXT[] NOT NULL DEFAULT '{}',
  physical_accessibility_needs TEXT[] NOT NULL DEFAULT '{}',

  budget_max_per_product_cents INT,
  budget_monthly_cap_cents INT,
  budget_preferred_band TEXT
    CHECK (budget_preferred_band IS NULL OR budget_preferred_band IN ('budget','mid','premium','any')),

  user_set_fields JSONB NOT NULL DEFAULT '{}',     -- { "allergies": true, "budget_max_per_product_cents": false, ... }
  field_last_verified JSONB NOT NULL DEFAULT '{}', -- { "allergies": "2026-04-16T..." }

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_limitations_tenant ON public.user_limitations (tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_limitations_allergies ON public.user_limitations USING GIN (allergies);
CREATE INDEX IF NOT EXISTS idx_user_limitations_dietary ON public.user_limitations USING GIN (dietary_restrictions);

-- ===========================================================================
-- 9. CONDITION → PRODUCT KNOWLEDGE BASE (curated, NOT scraped)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.condition_product_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  condition_key TEXT NOT NULL UNIQUE,              -- 'insomnia','low-hrv','chronic-stress',...
  display_label TEXT NOT NULL,
  description TEXT,

  recommended_ingredients JSONB NOT NULL DEFAULT '[]',  -- [{ingredient,evidence,rank}]
  recommended_health_goals TEXT[] NOT NULL DEFAULT '{}',
  recommended_categories TEXT[] NOT NULL DEFAULT '{}',
  recommended_form TEXT[] NOT NULL DEFAULT '{}',

  contraindicated_ingredients TEXT[] NOT NULL DEFAULT '{}',
  contraindicated_with_conditions TEXT[] NOT NULL DEFAULT '{}',
  contraindicated_with_medications TEXT[] NOT NULL DEFAULT '{}',

  evidence_level TEXT CHECK (evidence_level IS NULL OR evidence_level IN ('clinical','traditional','emerging','speculative')),
  evidence_citations JSONB NOT NULL DEFAULT '[]',

  typical_protocol TEXT,
  typical_timeline TEXT,
  cultural_variants JSONB NOT NULL DEFAULT '{}',

  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  authored_by TEXT,
  reviewed_by TEXT,                                 -- practitioner sign-off
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_condition_mappings_active
  ON public.condition_product_mappings (is_active);

-- ===========================================================================
-- 10. DEFAULT FEED CONFIG — admin-defined per-region × per-lifecycle-stage defaults
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.default_feed_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID,                                   -- NULL = platform-wide default
  region_group TEXT NOT NULL,                       -- 'EU','US','GLOBAL',...
  lifecycle_stage TEXT NOT NULL
    CHECK (lifecycle_stage IN ('onboarding','early','established','mature')),

  featured_product_ids UUID[] NOT NULL DEFAULT '{}',
  category_mix JSONB NOT NULL DEFAULT '{}',         -- {"supplements":0.4,"services":0.2,...}
  max_products_per_merchant INT NOT NULL DEFAULT 3,
  max_products_per_category INT,
  starter_conditions TEXT[] NOT NULL DEFAULT '{}',
  personalization_weight_override NUMERIC(4,3),     -- NULL = use stage default
  diversity_rules JSONB NOT NULL DEFAULT '{}',
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique active config per tenant + region + stage. Null tenant_id treated as platform default.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_default_feed_config_active
  ON public.default_feed_config (
    COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::UUID),
    region_group,
    lifecycle_stage
  )
  WHERE is_active = TRUE;

-- ===========================================================================
-- 11. PRODUCT CLICKS — affiliate click tracking (the join row for conversion)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.product_clicks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  click_id TEXT NOT NULL UNIQUE,                    -- stamped into affiliate URL sub-id
  user_id UUID,                                     -- nullable for anonymous clicks
  tenant_id UUID,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  merchant_id UUID REFERENCES public.merchants(id) ON DELETE SET NULL,
  attribution_surface TEXT,                         -- 'feed','search','orb','autopilot','share_and_earn'
  attribution_recommendation_id UUID,
  user_country CHAR(2),
  user_region TEXT,
  product_origin_country CHAR(2),
  product_ships_to_countries CHAR(2)[],
  target_url TEXT,                                  -- final redirected URL (for audit)
  ip_hash TEXT,                                     -- hashed for privacy
  user_agent_hash TEXT,
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_clicks_user ON public.product_clicks (user_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_clicks_product ON public.product_clicks (product_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_clicks_time ON public.product_clicks (clicked_at DESC);

-- ===========================================================================
-- 12. PRODUCT ORDERS — affiliate conversion rows (via postback)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.product_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  merchant_id UUID REFERENCES public.merchants(id) ON DELETE SET NULL,
  click_id TEXT,                                    -- joins to product_clicks
  external_order_id TEXT,                           -- the affiliate network's order ID
  checkout_mode TEXT NOT NULL DEFAULT 'affiliate_link'
    CHECK (checkout_mode IN ('affiliate_link','stripe_connect','embedded','manual')),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','converted','refunded','cancelled','chargeback','unmatched')),
  amount_cents INT,
  currency CHAR(3),
  commission_cents INT,
  raw JSONB,                                        -- full postback payload
  attribution_surface TEXT,
  attribution_recommendation_id UUID,
  condition_key TEXT,                               -- if this purchase was tied to a specific condition
  purchased_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_orders_user ON public.product_orders (user_id, purchased_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_product_orders_click ON public.product_orders (click_id);
CREATE INDEX IF NOT EXISTS idx_product_orders_state ON public.product_orders (state);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_product_orders_external
  ON public.product_orders (merchant_id, external_order_id)
  WHERE external_order_id IS NOT NULL;

-- ===========================================================================
-- 13. PRODUCT OUTCOMES — user-reported effect after purchase (feeds ranking)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.product_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  order_id UUID REFERENCES public.product_orders(id) ON DELETE SET NULL,
  purchased_at TIMESTAMPTZ,
  condition_key TEXT,
  self_reported_effect TEXT
    CHECK (self_reported_effect IS NULL OR self_reported_effect IN ('better','no_change','worse','side_effect','unsure')),
  effect_category TEXT,                             -- 'sleep','energy','mood','pain','digestion','focus','stress'
  effect_magnitude SMALLINT CHECK (effect_magnitude IS NULL OR effect_magnitude BETWEEN 1 AND 5),
  wearable_delta JSONB,                             -- auto-populated by Phase 2+ cron
  notes TEXT,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_outcomes_product_condition
  ON public.product_outcomes (product_id, condition_key, reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_outcomes_user
  ON public.product_outcomes (user_id, reported_at DESC);

-- ===========================================================================
-- 14. PRODUCT OUTCOME ROLLUP — materialized view consumed by analyzers
-- ===========================================================================

-- NOTE: refreshed nightly by cron (Phase 2 wires the cron; Phase 0 creates the view empty).
DROP MATERIALIZED VIEW IF EXISTS public.product_outcome_rollup;
CREATE MATERIALIZED VIEW public.product_outcome_rollup AS
SELECT
  product_id,
  condition_key,
  effect_category,
  COUNT(*) AS total_reports,
  COUNT(*) FILTER (WHERE self_reported_effect = 'better') AS better_count,
  COUNT(*) FILTER (WHERE self_reported_effect = 'no_change') AS no_change_count,
  COUNT(*) FILTER (WHERE self_reported_effect = 'worse') AS worse_count,
  COUNT(*) FILTER (WHERE self_reported_effect = 'side_effect') AS side_effect_count,
  ROUND(AVG(effect_magnitude) FILTER (WHERE effect_magnitude IS NOT NULL)::NUMERIC, 2) AS avg_magnitude,
  (COUNT(*) FILTER (WHERE self_reported_effect = 'better'))::NUMERIC
    / NULLIF(COUNT(*), 0) AS better_rate,
  MAX(reported_at) AS latest_report_at
FROM public.product_outcomes
WHERE reported_at > NOW() - INTERVAL '365 days'
GROUP BY product_id, condition_key, effect_category
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_product_outcome_rollup
  ON public.product_outcome_rollup (product_id, condition_key, effect_category);

COMMENT ON MATERIALIZED VIEW public.product_outcome_rollup IS
  'VTID-02000: Nightly-refreshed product outcome aggregates. Consumed by user-behavior-analyzer + marketplace-analyzer to weight ranking by historical outcome quality.';

-- ===========================================================================
-- 15. CANONICAL FACT KEYS — enforced taxonomy for memory_facts
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.canonical_fact_keys (
  key TEXT PRIMARY KEY,
  category TEXT NOT NULL,                           -- 'identity','health','dietary','medication','preference','limitation'
  value_type TEXT NOT NULL CHECK (value_type IN ('text','number','boolean','date','json','enum')),
  allowed_values TEXT[],                             -- for enum type
  description TEXT,
  affects_limitations BOOLEAN NOT NULL DEFAULT FALSE,  -- if true, a confirmed value here flows into user_limitations
  limitation_field TEXT,                             -- which column in user_limitations this key maps to
  requires_verification BOOLEAN NOT NULL DEFAULT FALSE,
  verification_cadence_days INT,                     -- prompt to re-confirm every N days
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Queue of non-canonical fact_key attempts observed by write_fact — admin reviews + canonicalizes.
CREATE TABLE IF NOT EXISTS public.canonical_fact_key_review_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observed_key TEXT NOT NULL,
  observed_sample_value TEXT,
  observation_count INT NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  canonicalized_to TEXT,                             -- set when admin maps this to a canonical key
  canonicalized_at TIMESTAMPTZ,
  canonicalized_by TEXT,
  UNIQUE (observed_key)
);

CREATE INDEX IF NOT EXISTS idx_canonical_fact_key_review_pending
  ON public.canonical_fact_key_review_queue (canonicalized_at)
  WHERE canonicalized_at IS NULL;

-- ===========================================================================
-- 16. CATALOG VOCABULARY — vocabularies for voice-search intent expansion
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.catalog_vocabulary (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vocabulary TEXT NOT NULL
    CHECK (vocabulary IN ('health_goals','dietary_tags','certifications','form','ingredients','topic_keys')),
  value TEXT NOT NULL,
  display_label TEXT,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (vocabulary, value)
);

CREATE INDEX IF NOT EXISTS idx_catalog_vocabulary_active
  ON public.catalog_vocabulary (vocabulary, is_active);

-- Natural-language phrase -> structured filter mapping (e.g. "restless nights" -> health_goals:['better-sleep'])
CREATE TABLE IF NOT EXISTS public.catalog_vocabulary_synonyms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phrase TEXT NOT NULL,                              -- user-spoken phrase (lowercased, normalized)
  maps_to_vocabulary TEXT NOT NULL,                  -- matches catalog_vocabulary.vocabulary
  maps_to_values TEXT[] NOT NULL,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0.9,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (phrase, maps_to_vocabulary)
);

CREATE INDEX IF NOT EXISTS idx_catalog_vocabulary_synonyms_phrase
  ON public.catalog_vocabulary_synonyms (phrase)
  WHERE is_active = TRUE;

-- ===========================================================================
-- 17. WEARABLE WAITLIST — Phase 0 stub until Phase 1 ships real connectors
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.wearable_waitlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  provider TEXT NOT NULL,                            -- 'apple_health','fitbit','oura','garmin','whoop','google_fit','samsung_health','strava','myfitnesspal'
  notify_via TEXT NOT NULL DEFAULT 'email',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at TIMESTAMPTZ,
  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_wearable_waitlist_provider
  ON public.wearable_waitlist (provider, created_at);

-- ===========================================================================
-- 18. LIMITATION BYPASS LOG — audit trail for soft-overridable per-query bypasses
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.limitation_bypass_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  bypassed_field TEXT NOT NULL,                      -- 'budget_max_per_product_cents','dietary_restrictions',...
  query_context JSONB,                               -- snapshot of what the user asked
  source TEXT,                                        -- 'orb','discover_ui','assistant'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_limitation_bypass_user
  ON public.limitation_bypass_log (user_id, created_at DESC);

-- ===========================================================================
-- 19. RLS POLICIES
-- ===========================================================================

-- Products + merchants + catalog_sources: GLOBAL read by authenticated users; writes via service_role only.
ALTER TABLE public.merchants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS merchants_select ON public.merchants;
CREATE POLICY merchants_select ON public.merchants FOR SELECT TO authenticated USING (is_active = TRUE);
DROP POLICY IF EXISTS merchants_service ON public.merchants;
CREATE POLICY merchants_service ON public.merchants FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS products_select ON public.products;
CREATE POLICY products_select ON public.products FOR SELECT TO authenticated USING (is_active = TRUE);
DROP POLICY IF EXISTS products_service ON public.products;
CREATE POLICY products_service ON public.products FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.catalog_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS catalog_sources_service ON public.catalog_sources;
CREATE POLICY catalog_sources_service ON public.catalog_sources FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.geo_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS geo_policy_select ON public.geo_policy;
CREATE POLICY geo_policy_select ON public.geo_policy FOR SELECT TO authenticated USING (is_active = TRUE);
DROP POLICY IF EXISTS geo_policy_service ON public.geo_policy;
CREATE POLICY geo_policy_service ON public.geo_policy FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.default_feed_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS default_feed_config_select ON public.default_feed_config;
CREATE POLICY default_feed_config_select ON public.default_feed_config FOR SELECT TO authenticated USING (is_active = TRUE);
DROP POLICY IF EXISTS default_feed_config_service ON public.default_feed_config;
CREATE POLICY default_feed_config_service ON public.default_feed_config FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.condition_product_mappings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS condition_mappings_select ON public.condition_product_mappings;
CREATE POLICY condition_mappings_select ON public.condition_product_mappings FOR SELECT TO authenticated USING (is_active = TRUE);
DROP POLICY IF EXISTS condition_mappings_service ON public.condition_product_mappings;
CREATE POLICY condition_mappings_service ON public.condition_product_mappings FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.canonical_fact_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS canonical_fact_keys_select ON public.canonical_fact_keys;
CREATE POLICY canonical_fact_keys_select ON public.canonical_fact_keys FOR SELECT TO authenticated USING (is_active = TRUE);
DROP POLICY IF EXISTS canonical_fact_keys_service ON public.canonical_fact_keys;
CREATE POLICY canonical_fact_keys_service ON public.canonical_fact_keys FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.canonical_fact_key_review_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS canonical_fact_key_review_service ON public.canonical_fact_key_review_queue;
CREATE POLICY canonical_fact_key_review_service ON public.canonical_fact_key_review_queue FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.catalog_vocabulary ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS catalog_vocabulary_select ON public.catalog_vocabulary;
CREATE POLICY catalog_vocabulary_select ON public.catalog_vocabulary FOR SELECT TO authenticated USING (is_active = TRUE);
DROP POLICY IF EXISTS catalog_vocabulary_service ON public.catalog_vocabulary;
CREATE POLICY catalog_vocabulary_service ON public.catalog_vocabulary FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.catalog_vocabulary_synonyms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS catalog_vocabulary_synonyms_select ON public.catalog_vocabulary_synonyms;
CREATE POLICY catalog_vocabulary_synonyms_select ON public.catalog_vocabulary_synonyms FOR SELECT TO authenticated USING (is_active = TRUE);
DROP POLICY IF EXISTS catalog_vocabulary_synonyms_service ON public.catalog_vocabulary_synonyms;
CREATE POLICY catalog_vocabulary_synonyms_service ON public.catalog_vocabulary_synonyms FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- Per-user tables: user sees only their own rows.
ALTER TABLE public.user_limitations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_limitations_select_own ON public.user_limitations;
CREATE POLICY user_limitations_select_own ON public.user_limitations
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS user_limitations_upsert_own ON public.user_limitations;
CREATE POLICY user_limitations_upsert_own ON public.user_limitations
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS user_limitations_update_own ON public.user_limitations;
CREATE POLICY user_limitations_update_own ON public.user_limitations
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS user_limitations_service ON public.user_limitations;
CREATE POLICY user_limitations_service ON public.user_limitations FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.wearable_waitlist ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wearable_waitlist_select_own ON public.wearable_waitlist;
CREATE POLICY wearable_waitlist_select_own ON public.wearable_waitlist
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS wearable_waitlist_insert_own ON public.wearable_waitlist;
CREATE POLICY wearable_waitlist_insert_own ON public.wearable_waitlist
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS wearable_waitlist_service ON public.wearable_waitlist;
CREATE POLICY wearable_waitlist_service ON public.wearable_waitlist FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.tenant_catalog_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_catalog_overrides_select ON public.tenant_catalog_overrides;
CREATE POLICY tenant_catalog_overrides_select ON public.tenant_catalog_overrides
  FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
DROP POLICY IF EXISTS tenant_catalog_overrides_service ON public.tenant_catalog_overrides;
CREATE POLICY tenant_catalog_overrides_service ON public.tenant_catalog_overrides FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.product_clicks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_clicks_select_own ON public.product_clicks;
CREATE POLICY product_clicks_select_own ON public.product_clicks
  FOR SELECT TO authenticated USING (user_id IS NULL OR user_id = auth.uid());
DROP POLICY IF EXISTS product_clicks_service ON public.product_clicks;
CREATE POLICY product_clicks_service ON public.product_clicks FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.product_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_orders_select_own ON public.product_orders;
CREATE POLICY product_orders_select_own ON public.product_orders
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS product_orders_service ON public.product_orders;
CREATE POLICY product_orders_service ON public.product_orders FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.product_outcomes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_outcomes_select_own ON public.product_outcomes;
CREATE POLICY product_outcomes_select_own ON public.product_outcomes
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS product_outcomes_insert_own ON public.product_outcomes;
CREATE POLICY product_outcomes_insert_own ON public.product_outcomes
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS product_outcomes_service ON public.product_outcomes;
CREATE POLICY product_outcomes_service ON public.product_outcomes FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.limitation_bypass_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS limitation_bypass_log_service ON public.limitation_bypass_log;
CREATE POLICY limitation_bypass_log_service ON public.limitation_bypass_log FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ===========================================================================
-- 20. GRANTS
-- ===========================================================================

GRANT SELECT ON public.merchants TO authenticated;
GRANT SELECT ON public.products TO authenticated;
GRANT SELECT ON public.geo_policy TO authenticated;
GRANT SELECT ON public.default_feed_config TO authenticated;
GRANT SELECT ON public.condition_product_mappings TO authenticated;
GRANT SELECT ON public.canonical_fact_keys TO authenticated;
GRANT SELECT ON public.catalog_vocabulary TO authenticated;
GRANT SELECT ON public.catalog_vocabulary_synonyms TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.user_limitations TO authenticated;
GRANT SELECT, INSERT ON public.wearable_waitlist TO authenticated;
GRANT SELECT, INSERT ON public.product_outcomes TO authenticated;
GRANT SELECT ON public.tenant_catalog_overrides TO authenticated;
GRANT SELECT ON public.product_clicks TO authenticated;
GRANT SELECT ON public.product_orders TO authenticated;
GRANT SELECT ON public.product_outcome_rollup TO authenticated;

-- ===========================================================================
-- 21. TABLE COMMENTS
-- ===========================================================================

COMMENT ON TABLE public.merchants IS 'VTID-02000: Global merchant registry. Marketplace-wide, not tenant-scoped — tenants hide via tenant_catalog_overrides.';
COMMENT ON TABLE public.products IS 'VTID-02000: Global rich-field product catalog with geo, health, and search metadata. Populated by ingestion API (Claude Code scraping).';
COMMENT ON TABLE public.catalog_sources IS 'VTID-02000: Ingestion run provenance — every scraping run stamped for audit + anomaly triage.';
COMMENT ON TABLE public.geo_policy IS 'VTID-02000: Admin-managed exclusion/preference rules per user-region × origin-region. Editable via Maxina Geo Policies screen.';
COMMENT ON TABLE public.user_limitations IS 'VTID-02000: Non-negotiable limitations profile per user. Applied by limitations-filter.ts before every product-returning endpoint.';
COMMENT ON TABLE public.condition_product_mappings IS 'VTID-02000: Curated knowledge base mapping health conditions to recommended/contraindicated ingredients. NOT scraped — hand-curated, versioned.';
COMMENT ON TABLE public.default_feed_config IS 'VTID-02000: Per-tenant × region × lifecycle-stage default feed composition. Drives the feed when personalization signal is thin.';
COMMENT ON TABLE public.product_clicks IS 'VTID-02000: Affiliate redirect click log. Joins with product_orders via click_id for attribution.';
COMMENT ON TABLE public.product_orders IS 'VTID-02000: Conversion rows from affiliate postbacks or embedded checkout. Idempotent via (merchant_id, external_order_id).';
COMMENT ON TABLE public.product_outcomes IS 'VTID-02000: User-reported product outcomes. Feeds product_outcome_rollup which is consumed by ranking.';
COMMENT ON TABLE public.canonical_fact_keys IS 'VTID-02000: Enforced taxonomy for memory_facts keys — health-relevant keys must be canonical to flow into user_limitations.';
COMMENT ON TABLE public.canonical_fact_key_review_queue IS 'VTID-02000: Observed non-canonical fact_keys for admin canonicalization in Taxonomy & Health Knowledge screen.';
COMMENT ON TABLE public.catalog_vocabulary IS 'VTID-02000: Allowed values for health_goals / dietary_tags / certifications / form / etc. used during ingestion validation and voice search.';
COMMENT ON TABLE public.catalog_vocabulary_synonyms IS 'VTID-02000: Natural-language phrase -> structured filter map for voice intent expansion (e.g. "restless nights" -> health_goals:better-sleep).';
COMMENT ON TABLE public.wearable_waitlist IS 'VTID-02000: Phase 0 stub — users opt in to be notified when their wearable provider goes live (Phase 1 Terra + iOS companion).';
COMMENT ON TABLE public.tenant_catalog_overrides IS 'VTID-02000: Per-tenant product/merchant/category hide list — lets a tenant restrict what its users see from the global catalog.';
COMMENT ON TABLE public.limitation_bypass_log IS 'VTID-02000: Audit trail for soft-overridable limitation bypasses (e.g. "just this once show me everything up to €100"). Never hard-bypasses allergies/medical.';
