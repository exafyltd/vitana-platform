-- Migration: 20260416170000_vtid_02000_fix_products.sql
-- Purpose: Recover products + dependent tables that failed in the foundation
--          migration. Root cause: the `search_text` GENERATED column used
--          to_tsvector('simple', ...) which PostgreSQL treats as STABLE (not
--          IMMUTABLE) — generation expressions must be immutable. Fix is to
--          cast the regconfig explicitly: to_tsvector('simple'::regconfig, ...).

-- Products (retry with the fix applied)
CREATE TABLE IF NOT EXISTS public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,

  source_network TEXT NOT NULL,
  source_product_id TEXT NOT NULL,
  gtin TEXT, sku TEXT, asin TEXT,

  title TEXT NOT NULL CHECK (title != ''),
  description TEXT,
  brand TEXT,
  category TEXT,
  subcategory TEXT,
  topic_keys TEXT[] NOT NULL DEFAULT '{}',

  price_cents INT,
  currency CHAR(3),
  compare_at_price_cents INT,

  images TEXT[] NOT NULL DEFAULT '{}',

  affiliate_url TEXT NOT NULL,
  availability TEXT NOT NULL DEFAULT 'in_stock'
    CHECK (availability IN ('in_stock','out_of_stock','preorder','discontinued','unknown')),
  rating NUMERIC(3,2),
  review_count INT,

  origin_country CHAR(2),
  origin_region TEXT,
  ships_to_countries CHAR(2)[],
  ships_to_regions TEXT[],
  excluded_from_regions TEXT[] NOT NULL DEFAULT '{}',
  customs_risk TEXT CHECK (customs_risk IS NULL OR customs_risk IN ('low','medium','high','unknown')),

  health_goals TEXT[] NOT NULL DEFAULT '{}',
  dietary_tags TEXT[] NOT NULL DEFAULT '{}',
  form TEXT,
  certifications TEXT[] NOT NULL DEFAULT '{}',
  ingredients_primary TEXT[] NOT NULL DEFAULT '{}',
  target_audience TEXT[] NOT NULL DEFAULT '{}',
  contains_allergens TEXT[] NOT NULL DEFAULT '{}',
  contraindicated_with_conditions TEXT[] NOT NULL DEFAULT '{}',
  contraindicated_with_medications TEXT[] NOT NULL DEFAULT '{}',

  embedding VECTOR(1536),
  -- FIX: cast 'simple' to regconfig so to_tsvector is IMMUTABLE
  search_text TSVECTOR
    GENERATED ALWAYS AS (
      setweight(to_tsvector('simple'::regconfig, COALESCE(title,'')), 'A') ||
      setweight(to_tsvector('simple'::regconfig, COALESCE(brand,'')), 'A') ||
      setweight(to_tsvector('simple'::regconfig, COALESCE(array_to_string(ingredients_primary,' '),'')), 'B') ||
      setweight(to_tsvector('simple'::regconfig, COALESCE(array_to_string(health_goals,' '),'')), 'B') ||
      setweight(to_tsvector('simple'::regconfig, COALESCE(description,'')), 'C')
    ) STORED,

  reward_preview JSONB,

  raw JSONB,
  content_hash TEXT,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  requires_admin_review BOOLEAN NOT NULL DEFAULT FALSE,
  admin_review_reason TEXT,
  analyzer_confidence NUMERIC(4,3),
  admin_notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (source_network, source_product_id)
);

-- Products region derivation trigger (was attempted but table didn't exist)
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

-- ivfflat embedding index — tolerate if pgvector unavailable
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_products_embedding'
  ) THEN
    BEGIN
      EXECUTE 'CREATE INDEX idx_products_embedding ON public.products USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skipping ivfflat index: %', SQLERRM;
    END;
  END IF;
END $$;

-- Dependent tables that failed because products didn't exist:

CREATE TABLE IF NOT EXISTS public.product_clicks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  click_id TEXT NOT NULL UNIQUE,
  user_id UUID,
  tenant_id UUID,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  merchant_id UUID REFERENCES public.merchants(id) ON DELETE SET NULL,
  attribution_surface TEXT,
  attribution_recommendation_id UUID,
  user_country CHAR(2),
  user_region TEXT,
  product_origin_country CHAR(2),
  product_ships_to_countries CHAR(2)[],
  target_url TEXT,
  ip_hash TEXT,
  user_agent_hash TEXT,
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_clicks_user ON public.product_clicks (user_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_clicks_product ON public.product_clicks (product_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_clicks_time ON public.product_clicks (clicked_at DESC);

CREATE TABLE IF NOT EXISTS public.product_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  merchant_id UUID REFERENCES public.merchants(id) ON DELETE SET NULL,
  click_id TEXT,
  external_order_id TEXT,
  checkout_mode TEXT NOT NULL DEFAULT 'affiliate_link'
    CHECK (checkout_mode IN ('affiliate_link','stripe_connect','embedded','manual')),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','converted','refunded','cancelled','chargeback','unmatched')),
  amount_cents INT,
  currency CHAR(3),
  commission_cents INT,
  raw JSONB,
  attribution_surface TEXT,
  attribution_recommendation_id UUID,
  condition_key TEXT,
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
  effect_category TEXT,
  effect_magnitude SMALLINT CHECK (effect_magnitude IS NULL OR effect_magnitude BETWEEN 1 AND 5),
  wearable_delta JSONB,
  notes TEXT,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_outcomes_product_condition
  ON public.product_outcomes (product_id, condition_key, reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_outcomes_user
  ON public.product_outcomes (user_id, reported_at DESC);

-- Materialized view that depends on product_outcomes
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

-- RLS policies for the recovered tables
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS products_select ON public.products;
CREATE POLICY products_select ON public.products FOR SELECT TO authenticated USING (is_active = TRUE);
DROP POLICY IF EXISTS products_service ON public.products;
CREATE POLICY products_service ON public.products FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

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

-- Grants
GRANT SELECT ON public.products TO authenticated;
GRANT SELECT ON public.product_clicks TO authenticated;
GRANT SELECT ON public.product_orders TO authenticated;
GRANT SELECT, INSERT ON public.product_outcomes TO authenticated;
GRANT SELECT ON public.product_outcome_rollup TO authenticated;

-- Refresh PostgREST
NOTIFY pgrst, 'reload schema';
