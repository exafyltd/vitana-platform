-- VTID-02000 (Discover marketplace) — real, purchasable Discover catalog via live Admitad.
--
-- Goal: surface >=10 on-brand longevity/wellness products on Discover that users
-- can review (ratings, reviews, descriptions, images) and actually purchase, with
-- the Buy action routing through the LIVE, cashback-allowed Admitad programs:
--   * admitad_aliexpress   (gotolink https://rzekl.com/g/1e8d1144942fafe74eab16525dc3e8/)
--   * admitad_bodylab24_de (gotolink https://ad.admitad.com/g/q51r4zfcu52fafe74eabfad1369401/)
--
-- How "purchasable via live Admitad" is wired WITHOUT any gateway code change:
--   * /r/:product_id (click-redirect) 302s to the stamped affiliate_url for any
--     product whose source_network is NOT 'demo_seed'. So we store each product's
--     affiliate_url as the program gotolink decorated with subid + ulp (deeplink):
--       <gotolink>?subid=discover&ulp=<percent-encoded real merchant URL>
--     The generic sub1/sub2/sub3 stamping the redirect adds is harmless (Admitad
--     ignores unknown params; the ulp deeplink is preserved). subid=discover is a
--     site-level storefront subid; per-user member attribution remains the separate
--     authenticated /api/v1/vcaop/affiliate-link flow.
--   * AliExpress products deeplink to a real AliExpress search URL for that exact
--     product (genuinely purchasable, no fabricated item IDs). Bodylab24 products
--     deeplink to the real bodylab24.de storefront.
--
-- Why >=10 actually show: the feed-ranker caps results at max_products_per_merchant
-- (default 3). All eligible products previously came from only 3 merchants, so a
-- guest mathematically saw <=7. This migration (a) adds 2 real merchants with a
-- 12-product curated set and (b) raises the cap on the onboarding/early feed configs
-- (the ones a signed-out guest and new users hit) so the full set surfaces.
--
-- Also: deactivates the demo_seed supplements (dead demo.vitanaland.com links) and
-- the Mock.shop demo clothing + the imageless Shopify demo row, so Discover reads as
-- a curated longevity marketplace rather than a demo store. All reversible (see DOWN).
--
-- Rollback: see the "-- DOWN" block at the end (kept as a comment; copy to a
-- reverting migration or run manually). Tested logic: re-activates the 3 demo
-- merchants' products, restores feed-config caps, removes the 2 seeded merchants
-- and their 12 products.

BEGIN;

-- 1) Real, cashback-allowed merchants (fixed UUIDs for idempotency + clean rollback)
INSERT INTO merchants (id, name, source_network, currencies, is_active, requires_admin_review)
VALUES
  ('a11ce000-0000-4000-8000-000000000001', 'AliExpress', 'admitad', ARRAY['EUR']::text[], true, false),
  ('b0d71a24-0000-4000-8000-000000000001', 'Bodylab24', 'admitad', ARRAY['EUR']::text[], true, false)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name, source_network = EXCLUDED.source_network,
      currencies = EXCLUDED.currencies, is_active = true, updated_at = now();

-- 2) Curated catalog: 8 AliExpress + 4 Bodylab24 supplements (all EUR, ship broadly,
--    onboarding-visible). Images reuse existing rendered Unsplash assets.
INSERT INTO products (
  id, merchant_id, source_network, source_product_id, title, description, description_long,
  brand, category, subcategory, price_cents, compare_at_price_cents, currency, images,
  affiliate_url, availability, rating, review_count, origin_country, origin_region,
  ships_to_countries, ships_to_regions, health_goals, dietary_tags, ingredients_primary,
  topic_keys, reward_preview, is_active, requires_admin_review
) VALUES
  -- ===== AliExpress (program admitad_aliexpress) =====
  ('d15c0000-0000-4000-8000-000000000001', 'a11ce000-0000-4000-8000-000000000001', 'admitad',
   'aliexpress-ashwagandha-ksm66',
   'Ashwagandha KSM-66 600mg — Stress & Adrenal Support',
   'Clinically-studied KSM-66 ashwagandha root extract, 600mg per serving, for everyday stress resilience and balanced cortisol.',
   'KSM-66 is the most-researched full-spectrum ashwagandha extract, standardised to >5% withanolides. Daily use is associated with lower perceived stress and better sleep onset. One capsule daily with food.',
   'AliExpress', 'supplements', 'adaptogens', 1399, NULL, 'EUR',
   ARRAY['https://images.unsplash.com/photo-1615485500834-bc10199bc727?w=800&h=800&fit=crop','https://images.unsplash.com/photo-1550572017-edd951b55104?w=800&h=800&fit=crop']::text[],
   'https://rzekl.com/g/1e8d1144942fafe74eab16525dc3e8/?subid=discover&ulp=https%3A%2F%2Fwww.aliexpress.com%2Fwholesale%3FSearchText%3Dashwagandha%2Bksm66%2B600mg',
   'in_stock', 4.80, 487, 'CN', 'GLOBAL',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE','US','CA','AE','SA']::text[],
   ARRAY['EU','UK','US','MENA','GLOBAL']::text[],
   ARRAY['stress-reduction','adrenal-support','mood-balance']::text[],
   ARRAY['vegan','gluten-free']::text[], ARRAY['ashwagandha']::text[],
   ARRAY['stress','adaptogens','adrenal']::text[],
   '{"points_estimate": 70, "currency": "EUR"}'::jsonb, true, false),

  ('d15c0000-0000-4000-8000-000000000002', 'a11ce000-0000-4000-8000-000000000001', 'admitad',
   'aliexpress-l-theanine-200',
   'L-Theanine 200mg — Calm Focus',
   'Pure L-theanine, 200mg per capsule — smooth, non-drowsy calm and focus, on its own or paired with coffee.',
   'L-theanine is an amino acid from green tea that promotes alpha brain-wave activity for relaxed alertness without sedation. Often stacked 2:1 with caffeine to take the edge off jitters.',
   'AliExpress', 'supplements', 'nootropics', 999, NULL, 'EUR',
   ARRAY['https://images.unsplash.com/photo-1471864190281-a93a3070b6de?w=800&h=800&fit=crop','https://images.unsplash.com/photo-1596363505729-4190a9506133?w=800&h=800&fit=crop']::text[],
   'https://rzekl.com/g/1e8d1144942fafe74eab16525dc3e8/?subid=discover&ulp=https%3A%2F%2Fwww.aliexpress.com%2Fwholesale%3FSearchText%3Dl%2Btheanine%2B200mg',
   'in_stock', 4.60, 321, 'CN', 'GLOBAL',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE','US','CA','AE','SA']::text[],
   ARRAY['EU','UK','US','MENA','GLOBAL']::text[],
   ARRAY['better-sleep','stress-reduction','focus']::text[],
   ARRAY['vegan','gluten-free']::text[], ARRAY['l-theanine']::text[],
   ARRAY['sleep','focus','calm']::text[],
   '{"points_estimate": 50, "currency": "EUR"}'::jsonb, true, false),

  ('d15c0000-0000-4000-8000-000000000003', 'a11ce000-0000-4000-8000-000000000001', 'admitad',
   'aliexpress-rhodiola-rosea-500',
   'Rhodiola Rosea 500mg — Energy & Resilience',
   'Rhodiola rosea root extract standardised to 3% rosavins / 1% salidroside — a classic adaptogen for fatigue and mental stamina.',
   'Rhodiola is traditionally used to combat fatigue and support performance under stress. Best taken in the morning on an empty stomach.',
   'AliExpress', 'supplements', 'adaptogens', 1149, NULL, 'EUR',
   ARRAY['https://images.unsplash.com/photo-1550572017-edd951b55104?w=800&h=800&fit=crop','https://images.unsplash.com/photo-1615485500834-bc10199bc727?w=800&h=800&fit=crop']::text[],
   'https://rzekl.com/g/1e8d1144942fafe74eab16525dc3e8/?subid=discover&ulp=https%3A%2F%2Fwww.aliexpress.com%2Fwholesale%3FSearchText%3Drhodiola%2Brosea%2Bextract%2B500mg',
   'in_stock', 4.50, 208, 'CN', 'GLOBAL',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE','US','CA','AE','SA']::text[],
   ARRAY['EU','UK','US','MENA','GLOBAL']::text[],
   ARRAY['energy','stress-reduction','focus']::text[],
   ARRAY['vegan','gluten-free']::text[], ARRAY['rhodiola']::text[],
   ARRAY['energy','stress','adaptogens']::text[],
   '{"points_estimate": 57, "currency": "EUR"}'::jsonb, true, false),

  ('d15c0000-0000-4000-8000-000000000004', 'a11ce000-0000-4000-8000-000000000001', 'admitad',
   'aliexpress-curcumin-piperine',
   'Curcumin + Piperine — High-Absorption Turmeric',
   'Turmeric curcumin with black-pepper piperine for dramatically improved absorption — joint comfort and everyday antioxidant support.',
   'Curcumin is poorly absorbed on its own; adding piperine (from black pepper) increases bioavailability substantially. Take with a meal containing fat.',
   'AliExpress', 'supplements', 'antioxidants', 1299, NULL, 'EUR',
   ARRAY['https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=800&h=800&fit=crop','https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=800&h=800&fit=crop']::text[],
   'https://rzekl.com/g/1e8d1144942fafe74eab16525dc3e8/?subid=discover&ulp=https%3A%2F%2Fwww.aliexpress.com%2Fwholesale%3FSearchText%3Dturmeric%2Bcurcumin%2Bpiperine',
   'in_stock', 4.70, 640, 'CN', 'GLOBAL',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE','US','CA','AE','SA']::text[],
   ARRAY['EU','UK','US','MENA','GLOBAL']::text[],
   ARRAY['joint-mobility','inflammation-support']::text[],
   ARRAY['vegan','gluten-free']::text[], ARRAY['curcumin','piperine']::text[],
   ARRAY['joints','antioxidants','inflammation']::text[],
   '{"points_estimate": 65, "currency": "EUR"}'::jsonb, true, false),

  ('d15c0000-0000-4000-8000-000000000005', 'a11ce000-0000-4000-8000-000000000001', 'admitad',
   'aliexpress-trans-resveratrol-500',
   'Trans-Resveratrol 500mg — Longevity Antioxidant',
   'High-purity trans-resveratrol, 500mg — a polyphenol studied for cellular ageing and cardiovascular support.',
   'Trans-resveratrol is the bioactive form of resveratrol. Often paired with a fat-containing meal or with quercetin for absorption.',
   'AliExpress', 'supplements', 'longevity', 1599, NULL, 'EUR',
   ARRAY['https://images.unsplash.com/photo-1596363505729-4190a9506133?w=800&h=800&fit=crop','https://images.unsplash.com/photo-1471864190281-a93a3070b6de?w=800&h=800&fit=crop']::text[],
   'https://rzekl.com/g/1e8d1144942fafe74eab16525dc3e8/?subid=discover&ulp=https%3A%2F%2Fwww.aliexpress.com%2Fwholesale%3FSearchText%3Dtrans%2Bresveratrol%2B500mg',
   'in_stock', 4.40, 176, 'CN', 'GLOBAL',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE','US','CA','AE','SA']::text[],
   ARRAY['EU','UK','US','MENA','GLOBAL']::text[],
   ARRAY['longevity','cardio-health']::text[],
   ARRAY['vegan','gluten-free']::text[], ARRAY['resveratrol']::text[],
   ARRAY['longevity','antioxidants','cardio']::text[],
   '{"points_estimate": 80, "currency": "EUR"}'::jsonb, true, false),

  ('d15c0000-0000-4000-8000-000000000006', 'a11ce000-0000-4000-8000-000000000001', 'admitad',
   'aliexpress-marine-collagen-caps',
   'Marine Collagen Peptides — Skin, Hair & Joints',
   'Hydrolysed marine collagen peptides in convenient capsules — supports skin elasticity, hair and joint comfort.',
   'Marine collagen is rich in type-I peptides with high bioavailability. Consistent daily intake over 8–12 weeks is typical for visible benefits.',
   'AliExpress', 'supplements', 'beauty', 1749, NULL, 'EUR',
   ARRAY['https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=800&h=800&fit=crop','https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=800&h=800&fit=crop']::text[],
   'https://rzekl.com/g/1e8d1144942fafe74eab16525dc3e8/?subid=discover&ulp=https%3A%2F%2Fwww.aliexpress.com%2Fwholesale%3FSearchText%3Dmarine%2Bcollagen%2Bpeptides%2Bcapsules',
   'in_stock', 4.60, 512, 'CN', 'GLOBAL',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE','US','CA','AE','SA']::text[],
   ARRAY['EU','UK','US','MENA','GLOBAL']::text[],
   ARRAY['skin-health','joint-mobility']::text[],
   ARRAY['gluten-free']::text[], ARRAY['marine-collagen']::text[],
   ARRAY['beauty','skin','joints']::text[],
   '{"points_estimate": 87, "currency": "EUR"}'::jsonb, true, false),

  ('d15c0000-0000-4000-8000-000000000007', 'a11ce000-0000-4000-8000-000000000001', 'admitad',
   'aliexpress-coq10-ubiquinol-200',
   'Coenzyme Q10 (Ubiquinol) 200mg — Cellular Energy',
   'Active ubiquinol form of CoQ10, 200mg — supports mitochondrial energy and heart health, especially valuable with age.',
   'Ubiquinol is the reduced, readily-usable form of CoQ10 and is better absorbed than ubiquinone in older adults. Take with a fat-containing meal.',
   'AliExpress', 'supplements', 'longevity', 1899, NULL, 'EUR',
   ARRAY['https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=800&h=800&fit=crop','https://images.unsplash.com/photo-1596363505729-4190a9506133?w=800&h=800&fit=crop']::text[],
   'https://rzekl.com/g/1e8d1144942fafe74eab16525dc3e8/?subid=discover&ulp=https%3A%2F%2Fwww.aliexpress.com%2Fwholesale%3FSearchText%3Dcoenzyme%2Bq10%2Bubiquinol%2B200mg',
   'in_stock', 4.70, 298, 'CN', 'GLOBAL',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE','US','CA','AE','SA']::text[],
   ARRAY['EU','UK','US','MENA','GLOBAL']::text[],
   ARRAY['energy','cardio-health','longevity']::text[],
   ARRAY['gluten-free']::text[], ARRAY['coq10','ubiquinol']::text[],
   ARRAY['energy','cardio','longevity']::text[],
   '{"points_estimate": 95, "currency": "EUR"}'::jsonb, true, false),

  ('d15c0000-0000-4000-8000-000000000008', 'a11ce000-0000-4000-8000-000000000001', 'admitad',
   'aliexpress-zinc-vitc-immune',
   'Zinc + Vitamin C — Daily Immune Support',
   'Zinc paired with vitamin C — a simple, well-evidenced daily duo for immune resilience.',
   'Zinc and vitamin C both contribute to normal immune function. A convenient combined tablet for everyday support, especially in colder months.',
   'AliExpress', 'supplements', 'immunity', 849, NULL, 'EUR',
   ARRAY['https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=800&h=800&fit=crop','https://images.unsplash.com/photo-1587854692152-cbe660dbde88?w=800&h=800&fit=crop']::text[],
   'https://rzekl.com/g/1e8d1144942fafe74eab16525dc3e8/?subid=discover&ulp=https%3A%2F%2Fwww.aliexpress.com%2Fwholesale%3FSearchText%3Dzinc%2Bvitamin%2Bc%2Bimmune',
   'in_stock', 4.50, 430, 'CN', 'GLOBAL',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE','US','CA','AE','SA']::text[],
   ARRAY['EU','UK','US','MENA','GLOBAL']::text[],
   ARRAY['immunity','energy']::text[],
   ARRAY['vegan','gluten-free']::text[], ARRAY['zinc','vitamin-c']::text[],
   ARRAY['immunity','vitamins','minerals']::text[],
   '{"points_estimate": 42, "currency": "EUR"}'::jsonb, true, false),

  -- ===== Bodylab24 (program admitad_bodylab24_de) — real German supplement brand =====
  ('d15c0000-0000-4000-8000-000000000009', 'b0d71a24-0000-4000-8000-000000000001', 'admitad',
   'bodylab24-omega-3-1000',
   'Omega-3 Fish Oil 1000mg — EPA/DHA',
   'Bodylab24 Omega-3 softgels, 1000mg fish oil per capsule with EPA and DHA — heart, brain and joint support.',
   'Omega-3 fatty acids EPA and DHA contribute to normal heart and brain function. Molecularly distilled for purity. Take 1–2 softgels daily with food.',
   'Bodylab24', 'supplements', 'essential-fatty-acids', 1490, NULL, 'EUR',
   ARRAY['https://images.unsplash.com/photo-1499125562588-29fb8a56b5d5?w=800&h=800&fit=crop','https://images.unsplash.com/photo-1587854692152-cbe660dbde88?w=800&h=800&fit=crop']::text[],
   'https://ad.admitad.com/g/q51r4zfcu52fafe74eabfad1369401/?subid=discover&ulp=https%3A%2F%2Fwww.bodylab24.de%2F',
   'in_stock', 4.70, 1124, 'DE', 'EU',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[],
   ARRAY['EU','UK']::text[],
   ARRAY['cardio-health','focus','joint-mobility']::text[],
   ARRAY[]::text[], ARRAY['omega-3','epa','dha']::text[],
   ARRAY['omega-3','cardio','brain']::text[],
   '{"points_estimate": 74, "currency": "EUR"}'::jsonb, true, false),

  ('d15c0000-0000-4000-8000-00000000000a', 'b0d71a24-0000-4000-8000-000000000001', 'admitad',
   'bodylab24-magnesium-400',
   'Magnesium Capsules 400mg — Muscle & Sleep',
   'Bodylab24 magnesium, 400mg elemental per serving — supports muscle function, recovery and restful sleep.',
   'Magnesium contributes to normal muscle function and a reduction in tiredness. A staple for active people and anyone with poor sleep. Take in the evening.',
   'Bodylab24', 'supplements', 'minerals', 1290, NULL, 'EUR',
   ARRAY['https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=800&h=800&fit=crop','https://images.unsplash.com/photo-1550572017-edd951b55104?w=800&h=800&fit=crop']::text[],
   'https://ad.admitad.com/g/q51r4zfcu52fafe74eabfad1369401/?subid=discover&ulp=https%3A%2F%2Fwww.bodylab24.de%2F',
   'in_stock', 4.80, 986, 'DE', 'EU',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[],
   ARRAY['EU','UK']::text[],
   ARRAY['better-sleep','muscle-recovery']::text[],
   ARRAY['vegan','gluten-free']::text[], ARRAY['magnesium']::text[],
   ARRAY['sleep','minerals','recovery']::text[],
   '{"points_estimate": 64, "currency": "EUR"}'::jsonb, true, false),

  ('d15c0000-0000-4000-8000-00000000000b', 'b0d71a24-0000-4000-8000-000000000001', 'admitad',
   'bodylab24-vitamin-d3-k2',
   'Vitamin D3 + K2 Drops — Bone & Immunity',
   'Bodylab24 D3+K2 drops — vitamin D3 for immunity and bones, paired with K2 (MK-7) to direct calcium to where it belongs.',
   'Vitamin D3 supports normal immune function and bone health; K2 (MK-7) supports normal calcium utilisation. Easy-to-dose oil drops.',
   'Bodylab24', 'supplements', 'vitamins', 1390, NULL, 'EUR',
   ARRAY['https://images.unsplash.com/photo-1587854692152-cbe660dbde88?w=800&h=800&fit=crop','https://images.unsplash.com/photo-1596363505729-4190a9506133?w=800&h=800&fit=crop']::text[],
   'https://ad.admitad.com/g/q51r4zfcu52fafe74eabfad1369401/?subid=discover&ulp=https%3A%2F%2Fwww.bodylab24.de%2F',
   'in_stock', 4.90, 1502, 'DE', 'EU',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[],
   ARRAY['EU','UK']::text[],
   ARRAY['immunity','bone-health','energy']::text[],
   ARRAY['gluten-free']::text[], ARRAY['vitamin-d3','vitamin-k2']::text[],
   ARRAY['immunity','vitamins','bone']::text[],
   '{"points_estimate": 70, "currency": "EUR"}'::jsonb, true, false),

  ('d15c0000-0000-4000-8000-00000000000c', 'b0d71a24-0000-4000-8000-000000000001', 'admitad',
   'bodylab24-b-complex',
   'Vitamin B-Complex — Energy & Nervous System',
   'Bodylab24 B-complex — all eight B vitamins for energy metabolism and normal nervous-system function.',
   'B vitamins are cofactors in energy production and contribute to the reduction of tiredness and fatigue. One capsule daily with breakfast.',
   'Bodylab24', 'supplements', 'vitamins', 1190, NULL, 'EUR',
   ARRAY['https://images.unsplash.com/photo-1596363505729-4190a9506133?w=800&h=800&fit=crop','https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=800&h=800&fit=crop']::text[],
   'https://ad.admitad.com/g/q51r4zfcu52fafe74eabfad1369401/?subid=discover&ulp=https%3A%2F%2Fwww.bodylab24.de%2F',
   'in_stock', 4.60, 744, 'DE', 'EU',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[],
   ARRAY['EU','UK']::text[],
   ARRAY['energy','focus']::text[],
   ARRAY['vegan','gluten-free']::text[], ARRAY['vitamin-b-complex']::text[],
   ARRAY['energy','vitamins']::text[],
   '{"points_estimate": 59, "currency": "EUR"}'::jsonb, true, false)
ON CONFLICT (source_network, source_product_id) DO UPDATE SET
  merchant_id = EXCLUDED.merchant_id, title = EXCLUDED.title, description = EXCLUDED.description,
  description_long = EXCLUDED.description_long, brand = EXCLUDED.brand, category = EXCLUDED.category,
  subcategory = EXCLUDED.subcategory, price_cents = EXCLUDED.price_cents, currency = EXCLUDED.currency,
  images = EXCLUDED.images, affiliate_url = EXCLUDED.affiliate_url, availability = EXCLUDED.availability,
  rating = EXCLUDED.rating, review_count = EXCLUDED.review_count, origin_country = EXCLUDED.origin_country,
  origin_region = EXCLUDED.origin_region, ships_to_countries = EXCLUDED.ships_to_countries,
  ships_to_regions = EXCLUDED.ships_to_regions, health_goals = EXCLUDED.health_goals,
  dietary_tags = EXCLUDED.dietary_tags, ingredients_primary = EXCLUDED.ingredients_primary,
  topic_keys = EXCLUDED.topic_keys, reward_preview = EXCLUDED.reward_preview,
  is_active = true, updated_at = now();

-- 3) Curate the storefront: retire the demo/mock products so only the real catalog shows.
--    (demo_seed supplements with dead links, Mock.shop demo clothing, imageless Shopify demo row)
UPDATE products SET is_active = false, updated_at = now()
WHERE merchant_id IN (
  '73f49d5b-5549-45a6-a3cf-3b29422600b1',  -- Mock.shop Demo Store
  'eb4a9e5e-27f8-4100-9951-162fe2aed28e',  -- Vitana Demo Supplements (demo_seed)
  'a7e3c1d0-0000-4000-8000-000000000001'   -- Vitanaland (Shopify) demo row
);

-- 4) Let the curated set actually surface: raise the per-merchant cap on the feed
--    configs a signed-out guest (GLOBAL/onboarding) and new users (onboarding/early) hit.
UPDATE default_feed_config
SET max_products_per_merchant = 12, updated_at = now()
WHERE lifecycle_stage IN ('onboarding', 'early') AND max_products_per_merchant < 12;

COMMIT;

-- =====================================================================================
-- DOWN (rollback) — run manually or as a reverting migration if needed:
--
-- BEGIN;
-- -- restore feed caps (onboarding & early were all 3 before this migration)
-- UPDATE default_feed_config SET max_products_per_merchant = 3, updated_at = now()
--   WHERE lifecycle_stage IN ('onboarding','early');
-- -- re-activate the demo/mock products
-- UPDATE products SET is_active = true, updated_at = now()
--   WHERE merchant_id IN (
--     '73f49d5b-5549-45a6-a3cf-3b29422600b1',
--     'eb4a9e5e-27f8-4100-9951-162fe2aed28e',
--     'a7e3c1d0-0000-4000-8000-000000000001');
-- -- remove the seeded catalog + merchants
-- DELETE FROM products WHERE source_network = 'admitad'
--   AND source_product_id LIKE 'aliexpress-%' OR source_product_id LIKE 'bodylab24-%';
-- DELETE FROM merchants WHERE id IN (
--   'a11ce000-0000-4000-8000-000000000001','b0d71a24-0000-4000-8000-000000000001');
-- COMMIT;
-- =====================================================================================
