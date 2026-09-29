-- VTID-04740 — referrer on the click; a signed-out buyer's sale can be attributed.
-- docs/COMMERCE-SUPPLIER-INFRASTRUCTURE-ARCHITECTURE.md §9.2 (plan step 3b).
--
-- 1. product_clicks gains the recommender the click was validated against
--    (VTID-04735 resolves ?rec_id= server-side). Stored on the click so a later
--    change to the referral row can never re-attribute a past click.
-- 2. product_clicks gains why a ?rec_id= was dropped (or 'unverified').
-- 3. product_orders.user_id becomes nullable. Buyers usually click a partner
--    link without a Vitana session, so the click (and therefore the order) has
--    no buyer id; with NOT NULL the order insert failed and the sale could not
--    be attributed at all. RLS policies compare user_id = auth.uid(), which a
--    NULL never satisfies, so no row becomes visible to anyone new.
--
-- Additive and relaxing only. Live data at authoring time: 0 product_orders,
-- 49 product_clicks.

ALTER TABLE public.product_clicks
  ADD COLUMN IF NOT EXISTS referrer_user_id UUID,
  ADD COLUMN IF NOT EXISTS attribution_rejected_reason TEXT;

COMMENT ON COLUMN public.product_clicks.referrer_user_id IS
  'VTID-04740: recommender of the validated referral this click carries (product_recommendations.user_id at click time).';
COMMENT ON COLUMN public.product_clicks.attribution_rejected_reason IS
  'VTID-04740: why the click''s ?rec_id= was dropped (malformed_id, not_found, disabled, product_mismatch, self_referral, excluded_account) or unverified.';

CREATE INDEX IF NOT EXISTS idx_product_clicks_referrer
  ON public.product_clicks (referrer_user_id, clicked_at DESC)
  WHERE referrer_user_id IS NOT NULL;

ALTER TABLE public.product_orders ALTER COLUMN user_id DROP NOT NULL;
