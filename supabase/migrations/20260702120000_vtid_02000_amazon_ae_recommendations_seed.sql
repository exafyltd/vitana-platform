-- VTID-02000 (Discover marketplace) — Amazon.ae recommendations-only seed.
--
-- impact-allow-solo-migration: intentional data-only migration. It seeds
-- catalog rows (merchants + products) fully consumed by EXISTING code — the
-- /r/:product_id click-redirect already 302s any non-'demo_seed' product to
-- its stamped affiliate_url (each row's URL already carries tag=vitanaland-21),
-- and discover-feed.ts + feed-ranker already read products. No gateway/worker
-- code touch needed.
--
-- Associate tag: vitanaland-21 (amazon.ae Store ID). Not a secret — appears in
-- every affiliate URL.
--
-- Recommendations-only per the Amazon Operating Agreement:
--   * source_network = 'amazon'  (NOT 'demo_seed' → click-redirect 302s to the
--     stamped affiliate_url; the amazon branch also injects `tag` from
--     VCAOP_AMAZON_AE_ASSOC_TAG if the URL lacks one — belt & braces).
--   * reward_preview = NULL       → NO cashback/points badge (forbidden by Amazon).
--   * affiliate_url = a REAL, tag-stamped amazon.ae URL. Curated items point to
--     a specific product page (/dp/<ASIN>, ASINs picked by the operator); any
--     not-yet-curated item falls back to an amazon.ae search URL for that
--     supplement. No fabricated ASINs.
--
-- Origin AE / region MENA; ships within UAE + wider MENA. Guest-onboarding
-- visible (feed cap already raised to 12 by the Admitad seed migration).

BEGIN;

-- 1) Amazon.ae merchant (fixed UUID for idempotency + clean rollback)
INSERT INTO merchants (id, name, source_network, currencies, is_active, requires_admin_review)
VALUES
  ('a4a20000-0000-4000-8000-000000000001', 'Amazon.ae', 'amazon', ARRAY['EUR']::text[], true, false)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name, source_network = EXCLUDED.source_network,
      currencies = EXCLUDED.currencies, is_active = true, updated_at = now();

-- 2) Curated amazon.ae longevity/wellness set (recommendations-only, reward_preview NULL).
--    Prices are indicative EUR (display only; real price shown on Amazon.ae,
--    which charges in AED — the card price is a EUR guide for our EU audience).
INSERT INTO products (
  id, merchant_id, source_network, source_product_id, title, description, description_long,
  brand, category, subcategory, price_cents, compare_at_price_cents, currency, images,
  affiliate_url, availability, rating, review_count, origin_country, origin_region,
  ships_to_countries, ships_to_regions, health_goals, dietary_tags, ingredients_primary,
  topic_keys, reward_preview, is_active, requires_admin_review
) VALUES
  ('a42d0000-0000-4000-8000-000000000001', 'a4a20000-0000-4000-8000-000000000001', 'amazon',
   'amazonae-ashwagandha-ksm66',
   'Ashwagandha KSM-66 — Stress & Adrenal Support',
   'Clinically-studied KSM-66 ashwagandha, for everyday stress resilience and balanced cortisol. Sold on Amazon.ae.',
   'KSM-66 is a full-spectrum ashwagandha root extract standardised to >5% withanolides, associated with lower perceived stress and better sleep onset. Browse current KSM-66 listings on Amazon.ae.',
   'Amazon.ae', 'supplements', 'adaptogens', 1490, NULL, 'EUR',
   ARRAY['https://images.unsplash.com/photo-1615485500834-bc10199bc727?w=800&h=800&fit=crop']::text[],
   'https://www.amazon.ae/dp/B094N78F17?tag=vitanaland-21',
   'in_stock', 4.60, 210, 'AE', 'MENA',
   ARRAY['AE','SA','KW','QA','BH','OM','DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[], ARRAY['MENA','EU','UK']::text[],
   ARRAY['stress-reduction','adrenal-support','mood-balance']::text[],
   ARRAY['vegan','gluten-free']::text[], ARRAY['ashwagandha']::text[],
   ARRAY['stress','adaptogens','adrenal']::text[],
   NULL, true, false),

  ('a42d0000-0000-4000-8000-000000000002', 'a4a20000-0000-4000-8000-000000000001', 'amazon',
   'amazonae-omega-3-fish-oil',
   'Omega-3 Fish Oil (EPA/DHA) — Heart, Brain & Joints',
   'High-strength omega-3 softgels with EPA and DHA. Sold on Amazon.ae.',
   'EPA and DHA contribute to normal heart and brain function. Browse molecularly-distilled omega-3 listings on Amazon.ae.',
   'Amazon.ae', 'supplements', 'essential-fatty-acids', 1690, NULL, 'EUR',
   ARRAY['https://images.unsplash.com/photo-1499125562588-29fb8a56b5d5?w=800&h=800&fit=crop']::text[],
   'https://www.amazon.ae/dp/B00KGCM13G?tag=vitanaland-21',
   'in_stock', 4.70, 540, 'AE', 'MENA',
   ARRAY['AE','SA','KW','QA','BH','OM','DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[], ARRAY['MENA','EU','UK']::text[],
   ARRAY['cardio-health','focus','joint-mobility']::text[],
   ARRAY[]::text[], ARRAY['omega-3','epa','dha']::text[],
   ARRAY['omega-3','cardio','brain']::text[],
   NULL, true, false),

  ('a42d0000-0000-4000-8000-000000000003', 'a4a20000-0000-4000-8000-000000000001', 'amazon',
   'amazonae-magnesium-glycinate',
   'Magnesium Glycinate — Muscle & Sleep',
   'Gentle, well-absorbed magnesium glycinate for muscle function, recovery and restful sleep. Sold on Amazon.ae.',
   'Magnesium contributes to normal muscle function and a reduction in tiredness. Glycinate is a gentle, highly-absorbable form. Browse listings on Amazon.ae.',
   'Amazon.ae', 'supplements', 'minerals', 1290, NULL, 'EUR',
   ARRAY['https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=800&h=800&fit=crop']::text[],
   'https://www.amazon.ae/dp/B0DVZQKPVN?tag=vitanaland-21',
   'in_stock', 4.70, 430, 'AE', 'MENA',
   ARRAY['AE','SA','KW','QA','BH','OM','DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[], ARRAY['MENA','EU','UK']::text[],
   ARRAY['better-sleep','muscle-recovery']::text[],
   ARRAY['vegan','gluten-free']::text[], ARRAY['magnesium']::text[],
   ARRAY['sleep','minerals','recovery']::text[],
   NULL, true, false),

  ('a42d0000-0000-4000-8000-000000000004', 'a4a20000-0000-4000-8000-000000000001', 'amazon',
   'amazonae-vitamin-d3-k2',
   'Vitamin D3 + K2 — Bone & Immunity',
   'Vitamin D3 for immunity and bones, paired with K2 (MK-7). Sold on Amazon.ae.',
   'Vitamin D3 supports normal immune function and bone health; K2 (MK-7) supports normal calcium utilisation. Browse D3+K2 listings on Amazon.ae.',
   'Amazon.ae', 'supplements', 'vitamins', 1190, NULL, 'EUR',
   ARRAY['https://images.unsplash.com/photo-1587854692152-cbe660dbde88?w=800&h=800&fit=crop']::text[],
   'https://www.amazon.ae/dp/B0038NF8MG?tag=vitanaland-21',
   'in_stock', 4.80, 690, 'AE', 'MENA',
   ARRAY['AE','SA','KW','QA','BH','OM','DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[], ARRAY['MENA','EU','UK']::text[],
   ARRAY['immunity','bone-health','energy']::text[],
   ARRAY['gluten-free']::text[], ARRAY['vitamin-d3','vitamin-k2']::text[],
   ARRAY['immunity','vitamins','bone']::text[],
   NULL, true, false),

  ('a42d0000-0000-4000-8000-000000000005', 'a4a20000-0000-4000-8000-000000000001', 'amazon',
   'amazonae-creatine-monohydrate',
   'Creatine Monohydrate — Strength & Cellular Energy',
   'Micronised creatine monohydrate for strength, power and cellular energy. Sold on Amazon.ae.',
   'Creatine monohydrate is one of the most-studied supplements for strength and lean-mass support, and is increasingly noted for cognitive and healthy-ageing benefits. Browse listings on Amazon.ae.',
   'Amazon.ae', 'supplements', 'performance', 1890, NULL, 'EUR',
   ARRAY['https://images.unsplash.com/photo-1550572017-edd951b55104?w=800&h=800&fit=crop']::text[],
   'https://www.amazon.ae/dp/B07978VPPH?tag=vitanaland-21',
   'in_stock', 4.80, 880, 'AE', 'MENA',
   ARRAY['AE','SA','KW','QA','BH','OM','DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[], ARRAY['MENA','EU','UK']::text[],
   ARRAY['muscle-recovery','energy','focus']::text[],
   ARRAY['vegan','gluten-free']::text[], ARRAY['creatine']::text[],
   ARRAY['performance','energy','strength']::text[],
   NULL, true, false),

  ('a42d0000-0000-4000-8000-000000000006', 'a4a20000-0000-4000-8000-000000000001', 'amazon',
   'amazonae-marine-collagen',
   'Marine Collagen Peptides — Skin, Hair & Joints',
   'Hydrolysed marine collagen peptides for skin elasticity, hair and joint comfort. Sold on Amazon.ae.',
   'Marine collagen is rich in type-I peptides with high bioavailability. Consistent daily intake over 8–12 weeks is typical for visible benefits. Browse listings on Amazon.ae.',
   'Amazon.ae', 'supplements', 'beauty', 2190, NULL, 'EUR',
   ARRAY['https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=800&h=800&fit=crop']::text[],
   'https://www.amazon.ae/dp/B09BT31TW2?tag=vitanaland-21',
   'in_stock', 4.60, 360, 'AE', 'MENA',
   ARRAY['AE','SA','KW','QA','BH','OM','DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[], ARRAY['MENA','EU','UK']::text[],
   ARRAY['skin-health','joint-mobility']::text[],
   ARRAY['gluten-free']::text[], ARRAY['marine-collagen']::text[],
   ARRAY['beauty','skin','joints']::text[],
   NULL, true, false),

  ('a42d0000-0000-4000-8000-000000000007', 'a4a20000-0000-4000-8000-000000000001', 'amazon',
   'amazonae-coq10-ubiquinol',
   'Coenzyme Q10 (Ubiquinol) — Cellular Energy',
   'Active ubiquinol form of CoQ10 for mitochondrial energy and heart health. Sold on Amazon.ae.',
   'Ubiquinol is the reduced, readily-usable form of CoQ10 and is better absorbed than ubiquinone in older adults. Browse listings on Amazon.ae.',
   'Amazon.ae', 'supplements', 'longevity', 2390, NULL, 'EUR',
   ARRAY['https://images.unsplash.com/photo-1596363505729-4190a9506133?w=800&h=800&fit=crop']::text[],
   'https://www.amazon.ae/dp/B0017QPMWM?tag=vitanaland-21',
   'in_stock', 4.70, 240, 'AE', 'MENA',
   ARRAY['AE','SA','KW','QA','BH','OM','DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[], ARRAY['MENA','EU','UK']::text[],
   ARRAY['energy','cardio-health','longevity']::text[],
   ARRAY['gluten-free']::text[], ARRAY['coq10','ubiquinol']::text[],
   ARRAY['energy','cardio','longevity']::text[],
   NULL, true, false),

  ('a42d0000-0000-4000-8000-000000000008', 'a4a20000-0000-4000-8000-000000000001', 'amazon',
   'amazonae-vitamin-c-1000',
   'Vitamin C 1000mg — Daily Immune Support',
   'High-strength vitamin C for everyday immune resilience and antioxidant support. Sold on Amazon.ae.',
   'Vitamin C contributes to normal immune function and the protection of cells from oxidative stress. Browse 1000mg listings on Amazon.ae.',
   'Amazon.ae', 'supplements', 'immunity', 890, NULL, 'EUR',
   ARRAY['https://images.unsplash.com/photo-1587854692152-cbe660dbde88?w=800&h=800&fit=crop']::text[],
   'https://www.amazon.ae/dp/B00JFF48I6?tag=vitanaland-21',
   'in_stock', 4.60, 510, 'AE', 'MENA',
   ARRAY['AE','SA','KW','QA','BH','OM','DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[], ARRAY['MENA','EU','UK']::text[],
   ARRAY['immunity','energy']::text[],
   ARRAY['vegan','gluten-free']::text[], ARRAY['vitamin-c']::text[],
   ARRAY['immunity','vitamins','antioxidants']::text[],
   NULL, true, false)
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

COMMIT;

-- =====================================================================================
-- DOWN (rollback):
-- BEGIN;
-- DELETE FROM products WHERE source_network = 'amazon' AND source_product_id LIKE 'amazonae-%';
-- DELETE FROM merchants WHERE id = 'a4a20000-0000-4000-8000-000000000001';
-- COMMIT;
-- =====================================================================================
