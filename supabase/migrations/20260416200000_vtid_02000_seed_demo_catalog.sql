-- Migration: 20260416200000_vtid_02000_seed_demo_catalog.sql
-- Purpose: Seed demo merchant + products so the marketplace is populated
--          for dogfooding + smoke tests until Claude Code's real scraping runs.
--
-- Seed covers the top-3 condition mappings: insomnia, chronic-stress, low-energy.
-- All products ship within EU (Germany-origin, ships to EU + UK). All vegan
-- except one non-vegan fish-oil for dietary-filter testing.
--
-- Idempotent: uses ON CONFLICT on (source_network, source_product_id).

DO $$
DECLARE
  v_run_id UUID;
  v_merchant_id UUID;
BEGIN
  -- 1. Start an ingestion run so provenance is audited
  INSERT INTO public.catalog_sources (source_network, triggered_by, notes)
  VALUES ('demo_seed', 'migration_20260416200000', 'Phase 0 dogfood seed: 1 merchant + 10 products covering insomnia/stress/low-energy')
  RETURNING run_id INTO v_run_id;

  -- 2. Merchant: EU-based supplement retailer
  INSERT INTO public.merchants (
    name, slug, storefront_url, source_network, source_merchant_id,
    merchant_country, ships_to_countries, ships_to_regions, currencies,
    avg_delivery_days_eu, avg_delivery_days_us,
    affiliate_network, commission_rate, quality_score, customs_risk, is_active
  )
  VALUES (
    'Vitana Demo Supplements',
    'vitana-demo-supplements',
    'https://demo.vitanaland.com',
    'demo_seed',
    'demo-merchant-eu-01',
    'DE',
    ARRAY['DE','FR','IT','ES','NL','BE','AT','PL','SE','DK','FI','IE','PT','CZ','GR','HU','RO','GB']::CHAR(2)[],
    ARRAY['EU','UK'],
    ARRAY['EUR','GBP'],
    3, 10,
    'demo',
    0.08,
    85,
    'low',
    TRUE
  )
  ON CONFLICT (source_network, source_merchant_id)
  DO UPDATE SET updated_at = NOW()
  RETURNING id INTO v_merchant_id;

  IF v_merchant_id IS NULL THEN
    SELECT id INTO v_merchant_id FROM public.merchants
    WHERE source_network = 'demo_seed' AND source_merchant_id = 'demo-merchant-eu-01';
  END IF;

  -- 3. Products — 10 items covering the three seeded conditions
  INSERT INTO public.products (
    merchant_id, source_network, source_product_id, title, description, brand,
    category, subcategory, price_cents, currency, affiliate_url, availability,
    rating, review_count, origin_country, ships_to_countries, ships_to_regions,
    topic_keys, health_goals, dietary_tags, form, certifications,
    ingredients_primary, target_audience, contains_allergens
  ) VALUES
    -- Insomnia / sleep
    (v_merchant_id, 'demo_seed', 'demo-sku-001',
     'Magnesium Glycinate 300mg — Vegan Capsules',
     'Bioavailable magnesium glycinate, 300mg per capsule. Supports sleep quality and muscle relaxation.',
     'Vitana Essentials', 'supplements', 'minerals', 2490, 'EUR',
     'https://demo.vitanaland.com/product/magnesium-glycinate',
     'in_stock', 4.7, 1240, 'DE', ARRAY['DE','FR','IT','ES','NL','BE','AT','PL','SE','GB']::CHAR(2)[], ARRAY['EU','UK'],
     ARRAY['sleep','minerals','recovery'], ARRAY['better-sleep','muscle-recovery'],
     ARRAY['vegan','gluten-free','non-gmo'], 'capsule',
     ARRAY['gmp-certified','vegan-society'],
     ARRAY['magnesium-glycinate'], ARRAY['adults'], ARRAY[]::TEXT[]),

    (v_merchant_id, 'demo_seed', 'demo-sku-002',
     'L-Theanine 200mg — Calm & Focus',
     'Pure L-Theanine from green tea. Supports calm focus and eases sleep onset without drowsiness.',
     'Vitana Essentials', 'supplements', 'amino-acids', 1890, 'EUR',
     'https://demo.vitanaland.com/product/l-theanine',
     'in_stock', 4.6, 872, 'DE', ARRAY['DE','FR','IT','ES','NL','AT','GB']::CHAR(2)[], ARRAY['EU','UK'],
     ARRAY['sleep','focus','calm'], ARRAY['better-sleep','stress-reduction','focus'],
     ARRAY['vegan','gluten-free'], 'capsule',
     ARRAY['gmp-certified'],
     ARRAY['l-theanine'], ARRAY['adults'], ARRAY[]::TEXT[]),

    (v_merchant_id, 'demo_seed', 'demo-sku-003',
     'Melatonin 0.3mg — Low-Dose Sleep Support',
     'Low-dose melatonin for restorative sleep. Non-habit-forming, wake up refreshed.',
     'Vitana Essentials', 'supplements', 'sleep', 1690, 'EUR',
     'https://demo.vitanaland.com/product/melatonin-low-dose',
     'in_stock', 4.5, 654, 'DE', ARRAY['DE','FR','IT','ES','NL','AT','GB']::CHAR(2)[], ARRAY['EU','UK'],
     ARRAY['sleep','circadian'], ARRAY['better-sleep','jet-lag-recovery'],
     ARRAY['vegan','gluten-free'], 'tablet',
     ARRAY['gmp-certified'],
     ARRAY['melatonin'], ARRAY['adults'], ARRAY[]::TEXT[]),

    -- Stress / adaptogens
    (v_merchant_id, 'demo_seed', 'demo-sku-004',
     'Ashwagandha KSM-66 600mg — Daily Stress Support',
     'Clinically-studied KSM-66 ashwagandha. Supports resilience to daily stress and healthy cortisol patterns.',
     'Vitana Essentials', 'supplements', 'adaptogens', 2990, 'EUR',
     'https://demo.vitanaland.com/product/ashwagandha-ksm66',
     'in_stock', 4.8, 2103, 'DE', ARRAY['DE','FR','IT','ES','NL','AT','PL','GB']::CHAR(2)[], ARRAY['EU','UK'],
     ARRAY['stress','adaptogens','adrenal'], ARRAY['stress-reduction','adrenal-support','mood-balance'],
     ARRAY['vegan','gluten-free','organic'], 'capsule',
     ARRAY['organic-eu','gmp-certified','vegan-society'],
     ARRAY['ashwagandha'], ARRAY['adults'], ARRAY[]::TEXT[]),

    (v_merchant_id, 'demo_seed', 'demo-sku-005',
     'Rhodiola Rosea 500mg — Energy & Adaptogen',
     'Standardized rhodiola extract. Supports mental stamina, physical energy, and stress response.',
     'Vitana Essentials', 'supplements', 'adaptogens', 2290, 'EUR',
     'https://demo.vitanaland.com/product/rhodiola-rosea',
     'in_stock', 4.4, 511, 'DE', ARRAY['DE','FR','IT','ES','NL','AT','GB']::CHAR(2)[], ARRAY['EU','UK'],
     ARRAY['stress','energy','adaptogens'], ARRAY['energy','stress-reduction','focus'],
     ARRAY['vegan','gluten-free'], 'capsule',
     ARRAY['gmp-certified'],
     ARRAY['rhodiola'], ARRAY['adults'], ARRAY[]::TEXT[]),

    -- Energy / low energy
    (v_merchant_id, 'demo_seed', 'demo-sku-006',
     'Vitamin B12 (Methylcobalamin) 1000mcg',
     'Active methylcobalamin form. Essential for energy metabolism and nervous system support.',
     'Vitana Essentials', 'supplements', 'vitamins', 1490, 'EUR',
     'https://demo.vitanaland.com/product/b12-methylcobalamin',
     'in_stock', 4.6, 1820, 'DE', ARRAY['DE','FR','IT','ES','NL','AT','PL','SE','DK','GB']::CHAR(2)[], ARRAY['EU','UK'],
     ARRAY['energy','vitamins'], ARRAY['energy','focus'],
     ARRAY['vegan','gluten-free'], 'sublingual',
     ARRAY['vegan-society'],
     ARRAY['vitamin-b12','methylcobalamin'], ARRAY['adults','seniors'], ARRAY[]::TEXT[]),

    (v_merchant_id, 'demo_seed', 'demo-sku-007',
     'Vitamin D3 4000 IU — Daily Vegan Drops',
     'Vegan D3 from lichen. Supports energy, immunity, and bone health during darker months.',
     'Vitana Essentials', 'supplements', 'vitamins', 1790, 'EUR',
     'https://demo.vitanaland.com/product/vitamin-d3-vegan',
     'in_stock', 4.9, 3012, 'DE', ARRAY['DE','FR','IT','ES','NL','AT','PL','SE','DK','FI','GB']::CHAR(2)[], ARRAY['EU','UK'],
     ARRAY['energy','vitamins','immunity'], ARRAY['energy','immunity','bone-health','mood-balance'],
     ARRAY['vegan','gluten-free','sugar-free'], 'liquid',
     ARRAY['vegan-society','gmp-certified'],
     ARRAY['vitamin-d3'], ARRAY['adults','seniors'], ARRAY[]::TEXT[]),

    (v_merchant_id, 'demo_seed', 'demo-sku-008',
     'Iron Bisglycinate 25mg — Gentle Iron',
     'Highly bioavailable iron bisglycinate. Supports energy production, gentler on the stomach than standard iron.',
     'Vitana Essentials', 'supplements', 'minerals', 1690, 'EUR',
     'https://demo.vitanaland.com/product/iron-bisglycinate',
     'in_stock', 4.5, 742, 'DE', ARRAY['DE','FR','IT','ES','NL','AT','GB']::CHAR(2)[], ARRAY['EU','UK'],
     ARRAY['energy','minerals'], ARRAY['energy','menstrual-support'],
     ARRAY['vegan','gluten-free'], 'capsule',
     ARRAY['gmp-certified'],
     ARRAY['iron-bisglycinate'], ARRAY['adults'], ARRAY[]::TEXT[]),

    -- Non-vegan (dietary-filter test)
    (v_merchant_id, 'demo_seed', 'demo-sku-009',
     'Omega-3 EPA/DHA 1200mg — Wild Fish Oil',
     'Premium wild-caught fish oil, 1200mg EPA+DHA per serving. Supports heart, brain, and joint health.',
     'Vitana Essentials', 'supplements', 'omega-3', 3290, 'EUR',
     'https://demo.vitanaland.com/product/omega-3-fish-oil',
     'in_stock', 4.7, 1988, 'DE', ARRAY['DE','FR','IT','ES','NL','AT','GB']::CHAR(2)[], ARRAY['EU','UK'],
     ARRAY['omega-3','cardio','brain'], ARRAY['cardio-health','focus','mood-balance','joint-mobility'],
     ARRAY[]::TEXT[], 'softgel',
     ARRAY['gmp-certified','third-party-tested'],
     ARRAY['omega-3','epa','dha'], ARRAY['adults','seniors'], ARRAY['fish']),

    -- Multi-condition (sleep + stress)
    (v_merchant_id, 'demo_seed', 'demo-sku-010',
     'Sleep & Calm Stack — Magnesium + Glycine + L-Theanine',
     'Synergistic night-time blend. Magnesium glycinate + glycine + L-theanine for deep, restorative sleep.',
     'Vitana Essentials', 'supplements', 'blends', 3490, 'EUR',
     'https://demo.vitanaland.com/product/sleep-calm-stack',
     'in_stock', 4.8, 1456, 'DE', ARRAY['DE','FR','IT','ES','NL','AT','PL','GB']::CHAR(2)[], ARRAY['EU','UK'],
     ARRAY['sleep','stress','blends'], ARRAY['better-sleep','stress-reduction','muscle-recovery'],
     ARRAY['vegan','gluten-free','non-gmo'], 'capsule',
     ARRAY['gmp-certified','vegan-society'],
     ARRAY['magnesium-glycinate','glycine','l-theanine'], ARRAY['adults'], ARRAY[]::TEXT[])

  ON CONFLICT (source_network, source_product_id)
  DO UPDATE SET
    updated_at = NOW(),
    last_seen_at = NOW(),
    is_active = EXCLUDED.is_active;

  -- 4. Close the ingestion run with stats
  UPDATE public.catalog_sources
  SET
    finished_at = NOW(),
    products_inserted = 10,
    products_updated = 0,
    products_skipped = 0
  WHERE run_id = v_run_id;
END $$;

-- Notify PostgREST (migration run script does this too, but belt + braces)
NOTIFY pgrst, 'reload schema';
