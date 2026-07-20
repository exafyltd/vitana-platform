-- VTID-02950: "Recommend & Earn" — user product recommendations + commissions.
--
-- Any community user can recommend a Discover product; if someone buys it via
-- that recommendation, the recommender earns a revenue-share of Vitana's own
-- earned commission, credited to their real wallet (wallet_accounts /
-- wallet_ledger_entries via credit_wallet_for_earning — see VTID-03249).
--
-- Schema notes:
--   - product_recommendations backs onto a sharing_links row (target_type=
--     'product', reusing its short_code generator) but the id stamped through
--     the click-redirect pipeline (product_clicks.attribution_recommendation_id
--     / product_orders.attribution_recommendation_id, both already UUID columns
--     from the VTID-02000 marketplace foundation) is product_recommendations.id.
--   - recommendation_commissions is the idempotent credit ledger — one row per
--     product_orders conversion, UNIQUE(product_order_id) is the double-credit
--     guard, mirroring product_orders' own uniq_product_orders_external pattern.
--   - merchants gets two new eligibility columns. Amazon is seeded ineligible:
--     the Amazon Operating Agreement forbids passing affiliate commission back
--     to end users as cashback/incentive (already documented in
--     20260702120000_vtid_02000_amazon_ae_recommendations_seed.sql's
--     reward_preview=NULL convention — this is the same constraint applied to
--     the new recommendation-commission feature).
--   - admin_settings is a small generic KV table for single-value admin config
--     (starts with just the default commission rate; reusable for future
--     single-value settings without a new table each time).

BEGIN;

-- ============================================================================
-- 1. admin_settings — generic KV config table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.admin_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.admin_settings (key, value)
VALUES ('recommendation_commission_default_rate', '{"rate": 0.20}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- 2. merchants — recommendation-commission eligibility
-- ============================================================================
ALTER TABLE public.merchants
  ADD COLUMN IF NOT EXISTS recommendation_commission_eligible BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS recommendation_commission_rate_override NUMERIC(5,4);

UPDATE public.merchants
SET recommendation_commission_eligible = false
WHERE source_network = 'amazon';

-- ============================================================================
-- 3. product_recommendations — one row per (user, product) recommendation
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.product_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID,
  user_id UUID NOT NULL,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  merchant_id UUID REFERENCES public.merchants(id) ON DELETE SET NULL,
  sharing_link_id UUID REFERENCES public.sharing_links(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  click_count INT NOT NULL DEFAULT 0,
  conversion_count INT NOT NULL DEFAULT 0,
  commission_earned_minor BIGINT NOT NULL DEFAULT 0,
  commission_currency CHAR(3) NOT NULL DEFAULT 'EUR',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_product_recommendations_user
  ON public.product_recommendations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_recommendations_product
  ON public.product_recommendations (product_id);

ALTER TABLE public.product_recommendations ENABLE ROW LEVEL SECURITY;

CREATE POLICY product_recommendations_owner_select ON public.product_recommendations
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY product_recommendations_owner_insert ON public.product_recommendations
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY product_recommendations_service_role ON public.product_recommendations
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ============================================================================
-- 4. recommendation_commissions — idempotent credit ledger
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.recommendation_commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_recommendation_id UUID NOT NULL REFERENCES public.product_recommendations(id) ON DELETE CASCADE,
  product_order_id UUID NOT NULL REFERENCES public.product_orders(id) ON DELETE CASCADE,
  recommender_user_id UUID NOT NULL,
  vitana_commission_cents INT NOT NULL,
  rate_applied NUMERIC(5,4) NOT NULL,
  payout_amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  wallet_ledger_entry_id UUID,
  status TEXT NOT NULL CHECK (status IN ('credited', 'skipped_ineligible', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_order_id)
);

CREATE INDEX IF NOT EXISTS idx_recommendation_commissions_recommender
  ON public.recommendation_commissions (recommender_user_id, created_at DESC);

ALTER TABLE public.recommendation_commissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY recommendation_commissions_owner_select ON public.recommendation_commissions
  FOR SELECT USING (auth.uid() = recommender_user_id);
CREATE POLICY recommendation_commissions_service_role ON public.recommendation_commissions
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ============================================================================
-- 5. increment_product_recommendation_stats — atomic counter bump
-- ============================================================================
CREATE OR REPLACE FUNCTION increment_product_recommendation_stats(
  p_recommendation_id UUID,
  p_commission_earned_minor BIGINT
) RETURNS VOID AS $$
BEGIN
  UPDATE public.product_recommendations
  SET conversion_count = conversion_count + 1,
      commission_earned_minor = commission_earned_minor + p_commission_earned_minor,
      updated_at = NOW()
  WHERE id = p_recommendation_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 6. increment_product_recommendation_click — bumps click_count on each visit
--    via a shared recommendation link (see routes/discover-recommendations.ts)
-- ============================================================================
CREATE OR REPLACE FUNCTION increment_product_recommendation_click(
  p_recommendation_id UUID
) RETURNS VOID AS $$
BEGIN
  UPDATE public.product_recommendations
  SET click_count = click_count + 1,
      updated_at = NOW()
  WHERE id = p_recommendation_id;
END;
$$ LANGUAGE plpgsql;

COMMIT;

-- =====================================================================================
-- DOWN (rollback):
-- DROP TABLE IF EXISTS public.recommendation_commissions;
-- DROP TABLE IF EXISTS public.product_recommendations;
-- ALTER TABLE public.merchants DROP COLUMN IF EXISTS recommendation_commission_eligible,
--   DROP COLUMN IF EXISTS recommendation_commission_rate_override;
-- DROP TABLE IF EXISTS public.admin_settings;
-- =====================================================================================
