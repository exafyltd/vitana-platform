-- VTID-02000: Seed compare_at_price_cents for 3 demo products so Flash Deals
-- tab has content to render. These are demo prices — real merchant promotions
-- land via the Shopify/CJ sync pipeline.

BEGIN;

UPDATE public.products
   SET compare_at_price_cents = CASE source_product_id
         -- 15% off: Ashwagandha KSM-66 (29.90 → 24.90)
         WHEN 'demo-sku-004' THEN 3499
         -- 20% off: Vitamin D3 (17.90 → 13.90)
         WHEN 'demo-sku-007' THEN 2190
         -- 25% off: Sleep & Calm Stack (44.90 → 33.90)
         WHEN 'demo-sku-010' THEN 4490
       END,
       updated_at = now()
 WHERE source_network = 'demo_seed'
   AND source_product_id IN ('demo-sku-004', 'demo-sku-007', 'demo-sku-010');

COMMIT;
