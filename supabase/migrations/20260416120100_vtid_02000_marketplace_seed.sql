-- Migration: 20260416120100_vtid_02000_marketplace_seed.sql
-- Purpose: VTID-02000 Seed data for marketplace foundation.
--          15 condition mappings, 9 default feed configs, geo policies,
--          canonical fact keys, vocabularies, voice synonyms.
--
-- Depends on: 20260416120000_vtid_02000_marketplace_foundation.sql

-- ===========================================================================
-- CANONICAL FACT KEYS — the enforced taxonomy for memory_facts health fields
-- ===========================================================================

INSERT INTO public.canonical_fact_keys (key, category, value_type, description, affects_limitations, limitation_field, requires_verification, verification_cadence_days)
VALUES
  -- Identity (already used by inline-fact-extractor)
  ('user_name', 'identity', 'text', 'Display name the user goes by', FALSE, NULL, FALSE, NULL),
  ('user_residence', 'identity', 'text', 'Country/city the user lives in', FALSE, NULL, FALSE, NULL),
  ('user_birthday', 'identity', 'date', 'Birth date (used to derive age_bracket)', TRUE, 'age_bracket', FALSE, NULL),
  ('user_occupation', 'identity', 'text', 'Job / profession', FALSE, NULL, FALSE, NULL),

  -- Health conditions (safety-critical, verified every 90d)
  ('user_allergy', 'health', 'text', 'Allergy to a food, ingredient, or substance', TRUE, 'allergies', TRUE, 90),
  ('user_medication', 'health', 'text', 'Current medication the user takes (for interaction checks)', TRUE, 'current_medications', TRUE, 90),
  ('user_health_condition', 'health', 'text', 'Self-reported health condition or diagnosis', TRUE, 'contraindications', TRUE, 180),
  ('user_pregnancy_status', 'health', 'enum', 'Pregnancy / nursing status — affects many supplement contraindications', TRUE, 'pregnancy_status', TRUE, 90),

  -- Dietary / preferences
  ('user_dietary_preference', 'dietary', 'text', 'Dietary restriction or preference (vegan, halal, gluten-free, etc.)', TRUE, 'dietary_restrictions', TRUE, 180),
  ('user_religious_restriction', 'dietary', 'text', 'Religious or cultural dietary restriction', TRUE, 'religious_restrictions', TRUE, 365),
  ('user_ingredient_sensitivity', 'health', 'text', 'Ingredient the user is sensitive to (caffeine, stimulants, melatonin, etc.)', TRUE, 'ingredient_sensitivities', TRUE, 180),

  -- Budget
  ('user_budget_ceiling', 'preference', 'number', 'Max per-product spend the user is comfortable with (minor units, e.g. cents)', TRUE, 'budget_max_per_product_cents', TRUE, 180),
  ('user_budget_monthly_cap', 'preference', 'number', 'Monthly marketplace spend cap (minor units)', TRUE, 'budget_monthly_cap_cents', TRUE, 180),
  ('user_budget_band', 'preference', 'enum', 'Preferred price band (budget/mid/premium/any) — influences ranking', TRUE, 'budget_preferred_band', FALSE, NULL),

  -- Accessibility
  ('user_physical_accessibility_need', 'preference', 'text', 'Accessibility requirement (swallowing, vision, mobility)', TRUE, 'physical_accessibility_needs', FALSE, NULL),

  -- Goals + topic signals (non-limitation)
  ('user_goal', 'preference', 'text', 'Stated wellness/health goal — feeds ranking only, not a hard filter', FALSE, NULL, FALSE, NULL),
  ('user_favorite_food', 'preference', 'text', 'Favored foods — flavor preference signal', FALSE, NULL, FALSE, NULL),
  ('user_favorite_drink', 'preference', 'text', 'Favored drinks — flavor preference signal', FALSE, NULL, FALSE, NULL)
ON CONFLICT (key) DO UPDATE
  SET description = EXCLUDED.description,
      affects_limitations = EXCLUDED.affects_limitations,
      limitation_field = EXCLUDED.limitation_field,
      requires_verification = EXCLUDED.requires_verification,
      verification_cadence_days = EXCLUDED.verification_cadence_days;

-- ===========================================================================
-- CATALOG VOCABULARY — allowed values for health_goals / dietary_tags / form / certifications
-- ===========================================================================

INSERT INTO public.catalog_vocabulary (vocabulary, value, display_label, sort_order) VALUES
  -- health_goals (20)
  ('health_goals', 'better-sleep', 'Better sleep', 10),
  ('health_goals', 'stress-reduction', 'Stress reduction', 20),
  ('health_goals', 'energy', 'More energy', 30),
  ('health_goals', 'focus', 'Focus & cognition', 40),
  ('health_goals', 'muscle-recovery', 'Muscle recovery', 50),
  ('health_goals', 'joint-mobility', 'Joint & mobility', 60),
  ('health_goals', 'digestive-health', 'Digestive health', 70),
  ('health_goals', 'immunity', 'Immune support', 80),
  ('health_goals', 'skin-health', 'Skin health', 90),
  ('health_goals', 'hair-nail-health', 'Hair & nails', 100),
  ('health_goals', 'mood-balance', 'Mood balance', 110),
  ('health_goals', 'hormonal-balance', 'Hormonal balance', 120),
  ('health_goals', 'weight-management', 'Weight management', 130),
  ('health_goals', 'cardio-health', 'Cardiovascular health', 140),
  ('health_goals', 'bone-health', 'Bone health', 150),
  ('health_goals', 'adrenal-support', 'Adrenal support', 160),
  ('health_goals', 'longevity', 'Longevity', 170),
  ('health_goals', 'menstrual-support', 'Menstrual support', 180),
  ('health_goals', 'post-workout-recovery', 'Post-workout recovery', 190),
  ('health_goals', 'jet-lag-recovery', 'Jet lag recovery', 200),

  -- dietary_tags (12)
  ('dietary_tags', 'vegan', 'Vegan', 10),
  ('dietary_tags', 'vegetarian', 'Vegetarian', 20),
  ('dietary_tags', 'halal', 'Halal', 30),
  ('dietary_tags', 'kosher', 'Kosher', 40),
  ('dietary_tags', 'gluten-free', 'Gluten-free', 50),
  ('dietary_tags', 'dairy-free', 'Dairy-free', 60),
  ('dietary_tags', 'nut-free', 'Nut-free', 70),
  ('dietary_tags', 'soy-free', 'Soy-free', 80),
  ('dietary_tags', 'sugar-free', 'Sugar-free', 90),
  ('dietary_tags', 'organic', 'Organic', 100),
  ('dietary_tags', 'non-gmo', 'Non-GMO', 110),
  ('dietary_tags', 'keto-friendly', 'Keto-friendly', 120),

  -- form (8)
  ('form', 'capsule', 'Capsule', 10),
  ('form', 'tablet', 'Tablet', 20),
  ('form', 'powder', 'Powder', 30),
  ('form', 'liquid', 'Liquid', 40),
  ('form', 'gummy', 'Gummy', 50),
  ('form', 'softgel', 'Softgel', 60),
  ('form', 'spray', 'Spray', 70),
  ('form', 'other', 'Other', 80),

  -- certifications (10)
  ('certifications', 'organic-eu', 'EU Organic', 10),
  ('certifications', 'organic-usda', 'USDA Organic', 20),
  ('certifications', 'fair-trade', 'Fair Trade', 30),
  ('certifications', 'gmp-certified', 'GMP Certified', 40),
  ('certifications', 'usp-verified', 'USP Verified', 50),
  ('certifications', 'ecocert', 'Ecocert', 60),
  ('certifications', 'vegan-society', 'Vegan Society', 70),
  ('certifications', 'halal-certified', 'Halal Certified', 80),
  ('certifications', 'kosher-certified', 'Kosher Certified', 90),
  ('certifications', 'third-party-tested', 'Third-party tested', 100)
ON CONFLICT (vocabulary, value) DO NOTHING;

-- ===========================================================================
-- CATALOG VOCABULARY SYNONYMS — voice intent expansion
-- ===========================================================================

INSERT INTO public.catalog_vocabulary_synonyms (phrase, maps_to_vocabulary, maps_to_values, confidence) VALUES
  -- Sleep
  ('restless nights', 'health_goals', ARRAY['better-sleep'], 0.95),
  ('cant sleep', 'health_goals', ARRAY['better-sleep'], 0.95),
  ('insomnia', 'health_goals', ARRAY['better-sleep'], 0.98),
  ('tossing and turning', 'health_goals', ARRAY['better-sleep'], 0.9),
  ('poor sleep', 'health_goals', ARRAY['better-sleep'], 0.95),
  ('trouble falling asleep', 'health_goals', ARRAY['better-sleep'], 0.95),

  -- Stress / mood
  ('stress at work', 'health_goals', ARRAY['stress-reduction','focus'], 0.9),
  ('anxious', 'health_goals', ARRAY['stress-reduction','mood-balance'], 0.9),
  ('anxiety', 'health_goals', ARRAY['stress-reduction','mood-balance'], 0.95),
  ('overwhelmed', 'health_goals', ARRAY['stress-reduction'], 0.85),
  ('feeling down', 'health_goals', ARRAY['mood-balance'], 0.85),

  -- Energy / focus
  ('tired all day', 'health_goals', ARRAY['energy','adrenal-support'], 0.95),
  ('low energy', 'health_goals', ARRAY['energy'], 0.95),
  ('brain fog', 'health_goals', ARRAY['focus'], 0.95),
  ('cant concentrate', 'health_goals', ARRAY['focus'], 0.9),

  -- Pain / joints
  ('joint pain', 'health_goals', ARRAY['joint-mobility'], 0.95),
  ('sore muscles', 'health_goals', ARRAY['muscle-recovery'], 0.95),
  ('back pain', 'health_goals', ARRAY['joint-mobility'], 0.85),

  -- Immunity / seasonal
  ('cold season', 'health_goals', ARRAY['immunity'], 0.9),
  ('getting sick often', 'health_goals', ARRAY['immunity'], 0.9),

  -- Digestion
  ('bloated', 'health_goals', ARRAY['digestive-health'], 0.9),
  ('stomach issues', 'health_goals', ARRAY['digestive-health'], 0.85),
  ('ibs', 'health_goals', ARRAY['digestive-health'], 0.95),

  -- Menstrual / hormonal
  ('period cramps', 'health_goals', ARRAY['menstrual-support'], 0.95),
  ('pms', 'health_goals', ARRAY['menstrual-support','hormonal-balance'], 0.95),
  ('hormone balance', 'health_goals', ARRAY['hormonal-balance'], 0.95),

  -- Travel
  ('jet lag', 'health_goals', ARRAY['jet-lag-recovery','better-sleep'], 0.95),
  ('traveling next week', 'health_goals', ARRAY['jet-lag-recovery'], 0.8),

  -- Dietary (mapped to dietary_tags)
  ('i am vegan', 'dietary_tags', ARRAY['vegan'], 0.98),
  ('plant based', 'dietary_tags', ARRAY['vegan','vegetarian'], 0.9),
  ('gluten free', 'dietary_tags', ARRAY['gluten-free'], 0.98),
  ('no dairy', 'dietary_tags', ARRAY['dairy-free'], 0.95)
ON CONFLICT (phrase, maps_to_vocabulary) DO NOTHING;

-- ===========================================================================
-- CONDITION → PRODUCT KNOWLEDGE BASE — 15 curated mappings
-- ===========================================================================

INSERT INTO public.condition_product_mappings
  (condition_key, display_label, description, recommended_ingredients, recommended_health_goals, recommended_categories, contraindicated_ingredients, contraindicated_with_conditions, contraindicated_with_medications, evidence_level, typical_protocol, typical_timeline, authored_by)
VALUES
  ('insomnia', 'Insomnia / poor sleep', 'Reduced sleep quality, difficulty falling or staying asleep',
   '[{"ingredient":"magnesium-glycinate","evidence":"strong","rank":1},{"ingredient":"l-theanine","evidence":"moderate","rank":2},{"ingredient":"glycine","evidence":"moderate","rank":3},{"ingredient":"melatonin","evidence":"strong","rank":4},{"ingredient":"valerian-root","evidence":"emerging","rank":5}]'::JSONB,
   ARRAY['better-sleep'], ARRAY['supplements'],
   ARRAY['caffeine','high-dose-b-vitamins'], ARRAY['bipolar-disorder'], ARRAY['mao-inhibitors','benzodiazepines'],
   'clinical', 'Start magnesium glycinate 300mg, 1h before bed, 4 weeks.', 'Expect noticeable effect in 2-3 weeks.', 'VTID-02000-seed'),

  ('low-hrv', 'Low heart rate variability', 'Chronic low HRV — indicator of autonomic stress / recovery deficit',
   '[{"ingredient":"magnesium-glycinate","evidence":"moderate","rank":1},{"ingredient":"omega-3","evidence":"strong","rank":2},{"ingredient":"adaptogens-ashwagandha","evidence":"emerging","rank":3}]'::JSONB,
   ARRAY['stress-reduction','cardio-health'], ARRAY['supplements'],
   ARRAY['stimulants','high-caffeine'], ARRAY['pregnancy','hyperthyroid'], ARRAY['blood-thinners'],
   'emerging', 'Omega-3 2g/day + breathwork.', '4-6 weeks for HRV trend shift.', 'VTID-02000-seed'),

  ('chronic-stress', 'Chronic stress', 'Sustained high perceived stress load',
   '[{"ingredient":"ashwagandha","evidence":"strong","rank":1},{"ingredient":"rhodiola","evidence":"moderate","rank":2},{"ingredient":"l-theanine","evidence":"moderate","rank":3},{"ingredient":"magnesium-glycinate","evidence":"strong","rank":4}]'::JSONB,
   ARRAY['stress-reduction','adrenal-support','mood-balance'], ARRAY['supplements'],
   ARRAY['caffeine'], ARRAY['pregnancy','autoimmune','hyperthyroid'], ARRAY['ssri','thyroid-medication','benzodiazepines'],
   'clinical', 'Ashwagandha KSM-66 600mg/day, 8 weeks.', '3-4 weeks for perceived effect.', 'VTID-02000-seed'),

  ('low-energy', 'Chronic low energy / fatigue', 'Persistent fatigue not explained by sleep deficit alone',
   '[{"ingredient":"vitamin-b12","evidence":"strong","rank":1},{"ingredient":"iron-bisglycinate","evidence":"strong","rank":2},{"ingredient":"coq10","evidence":"moderate","rank":3},{"ingredient":"vitamin-d3","evidence":"strong","rank":4},{"ingredient":"rhodiola","evidence":"moderate","rank":5}]'::JSONB,
   ARRAY['energy','adrenal-support'], ARRAY['supplements'],
   ARRAY[]::TEXT[], ARRAY['hemochromatosis'], ARRAY['levothyroxine','anticoagulants'],
   'clinical', 'Start vitamin D3 2000IU/day + B12 1000mcg if deficient.', '4-8 weeks.', 'VTID-02000-seed'),

  ('poor-focus', 'Poor focus / brain fog', 'Cognitive fog, difficulty concentrating',
   '[{"ingredient":"omega-3-dha","evidence":"strong","rank":1},{"ingredient":"l-tyrosine","evidence":"moderate","rank":2},{"ingredient":"bacopa-monnieri","evidence":"moderate","rank":3},{"ingredient":"lions-mane","evidence":"emerging","rank":4}]'::JSONB,
   ARRAY['focus'], ARRAY['supplements'],
   ARRAY['high-caffeine'], ARRAY['bipolar-disorder','mania'], ARRAY['mao-inhibitors','levothyroxine'],
   'emerging', 'DHA 1g/day for 8 weeks.', '4-8 weeks.', 'VTID-02000-seed'),

  ('post-workout-recovery', 'Post-workout recovery', 'Slow recovery between training sessions',
   '[{"ingredient":"whey-protein","evidence":"strong","rank":1},{"ingredient":"creatine-monohydrate","evidence":"strong","rank":2},{"ingredient":"magnesium-glycinate","evidence":"moderate","rank":3},{"ingredient":"tart-cherry","evidence":"moderate","rank":4},{"ingredient":"bcaa","evidence":"moderate","rank":5}]'::JSONB,
   ARRAY['muscle-recovery','post-workout-recovery'], ARRAY['supplements'],
   ARRAY[]::TEXT[], ARRAY['kidney-disease'], ARRAY[]::TEXT[],
   'clinical', 'Whey 20-30g post-workout + creatine 5g/day.', 'Noticeable within 2 weeks.', 'VTID-02000-seed'),

  ('seasonal-immunity', 'Seasonal immunity support', 'Supporting immune function during cold/flu season',
   '[{"ingredient":"vitamin-c","evidence":"moderate","rank":1},{"ingredient":"vitamin-d3","evidence":"strong","rank":2},{"ingredient":"zinc","evidence":"strong","rank":3},{"ingredient":"elderberry","evidence":"moderate","rank":4},{"ingredient":"quercetin","evidence":"emerging","rank":5}]'::JSONB,
   ARRAY['immunity'], ARRAY['supplements'],
   ARRAY[]::TEXT[], ARRAY['autoimmune','hemochromatosis'], ARRAY['immunosuppressants'],
   'clinical', 'Vitamin D3 2000-4000 IU/day + Zinc 15-25mg/day.', 'Ongoing during high-risk season.', 'VTID-02000-seed'),

  ('menstrual-cramps', 'Menstrual cramps', 'Painful menstruation',
   '[{"ingredient":"magnesium-glycinate","evidence":"strong","rank":1},{"ingredient":"omega-3","evidence":"moderate","rank":2},{"ingredient":"vitamin-b1","evidence":"moderate","rank":3},{"ingredient":"chasteberry","evidence":"emerging","rank":4}]'::JSONB,
   ARRAY['menstrual-support','hormonal-balance'], ARRAY['supplements'],
   ARRAY[]::TEXT[], ARRAY['pregnancy'], ARRAY['hormonal-contraceptives'],
   'clinical', 'Magnesium 300mg/day; start 1 week before cycle.', '1-3 cycles.', 'VTID-02000-seed'),

  ('joint-pain', 'Joint pain / mobility', 'Joint discomfort, reduced mobility',
   '[{"ingredient":"collagen-peptides","evidence":"moderate","rank":1},{"ingredient":"omega-3","evidence":"strong","rank":2},{"ingredient":"turmeric-curcumin","evidence":"moderate","rank":3},{"ingredient":"glucosamine","evidence":"moderate","rank":4},{"ingredient":"msm","evidence":"emerging","rank":5}]'::JSONB,
   ARRAY['joint-mobility'], ARRAY['supplements'],
   ARRAY[]::TEXT[], ARRAY['pregnancy','bleeding-disorders'], ARRAY['blood-thinners','nsaids'],
   'clinical', 'Collagen 10-20g/day + omega-3 2g/day.', '6-12 weeks.', 'VTID-02000-seed'),

  ('digestive-irritation', 'Digestive irritation / bloating', 'Gut discomfort, bloating, irregular digestion',
   '[{"ingredient":"probiotic-multi-strain","evidence":"moderate","rank":1},{"ingredient":"digestive-enzymes","evidence":"moderate","rank":2},{"ingredient":"l-glutamine","evidence":"emerging","rank":3},{"ingredient":"peppermint-oil","evidence":"moderate","rank":4}]'::JSONB,
   ARRAY['digestive-health'], ARRAY['supplements'],
   ARRAY[]::TEXT[], ARRAY['sibo','immunocompromised'], ARRAY['immunosuppressants'],
   'emerging', 'Probiotic 10-50B CFU/day, 8 weeks.', '2-4 weeks for bloating relief.', 'VTID-02000-seed'),

  ('mild-low-mood', 'Mild low mood / blues', 'Mild mood downturn — NOT a substitute for clinical care',
   '[{"ingredient":"vitamin-d3","evidence":"strong","rank":1},{"ingredient":"omega-3-epa","evidence":"strong","rank":2},{"ingredient":"saffron","evidence":"emerging","rank":3},{"ingredient":"sam-e","evidence":"moderate","rank":4}]'::JSONB,
   ARRAY['mood-balance'], ARRAY['supplements'],
   ARRAY['stimulants'], ARRAY['bipolar-disorder','pregnancy'], ARRAY['ssri','snri','mao-inhibitors'],
   'clinical', 'Omega-3 EPA 1g/day + Vitamin D3 2000IU/day.', '6-8 weeks.', 'VTID-02000-seed'),

  ('migraines', 'Migraines / tension headaches', 'Recurrent headaches / migraines',
   '[{"ingredient":"magnesium-glycinate","evidence":"strong","rank":1},{"ingredient":"riboflavin-b2","evidence":"strong","rank":2},{"ingredient":"coq10","evidence":"moderate","rank":3},{"ingredient":"feverfew","evidence":"emerging","rank":4}]'::JSONB,
   ARRAY['focus'], ARRAY['supplements'],
   ARRAY[]::TEXT[], ARRAY['pregnancy','bleeding-disorders'], ARRAY['blood-thinners'],
   'clinical', 'Magnesium 400-600mg/day + Riboflavin 400mg/day.', '8-12 weeks for frequency reduction.', 'VTID-02000-seed'),

  ('skin-inflammation', 'Skin inflammation / eczema', 'Inflamed or irritated skin',
   '[{"ingredient":"omega-3","evidence":"strong","rank":1},{"ingredient":"probiotic","evidence":"moderate","rank":2},{"ingredient":"evening-primrose-oil","evidence":"moderate","rank":3},{"ingredient":"zinc","evidence":"moderate","rank":4}]'::JSONB,
   ARRAY['skin-health'], ARRAY['supplements'],
   ARRAY[]::TEXT[], ARRAY['bleeding-disorders'], ARRAY['blood-thinners'],
   'emerging', 'Omega-3 2g/day + topical care.', '8-12 weeks.', 'VTID-02000-seed'),

  ('cold-flu-recovery', 'Cold / flu recovery', 'Speeding recovery from acute respiratory infection',
   '[{"ingredient":"zinc-lozenge","evidence":"strong","rank":1},{"ingredient":"vitamin-c","evidence":"moderate","rank":2},{"ingredient":"elderberry","evidence":"moderate","rank":3},{"ingredient":"nac","evidence":"emerging","rank":4}]'::JSONB,
   ARRAY['immunity'], ARRAY['supplements'],
   ARRAY[]::TEXT[], ARRAY['autoimmune'], ARRAY['immunosuppressants'],
   'moderate', 'Zinc lozenge 75mg/day during first 24h of symptoms.', '3-7 days.', 'VTID-02000-seed'),

  ('jet-lag', 'Jet lag', 'Circadian disruption from long-haul travel',
   '[{"ingredient":"melatonin","evidence":"strong","rank":1},{"ingredient":"magnesium-glycinate","evidence":"moderate","rank":2},{"ingredient":"electrolytes","evidence":"emerging","rank":3}]'::JSONB,
   ARRAY['jet-lag-recovery','better-sleep'], ARRAY['supplements'],
   ARRAY[]::TEXT[], ARRAY['pregnancy','autoimmune'], ARRAY['immunosuppressants','blood-thinners'],
   'clinical', 'Melatonin 0.5-3mg at target bedtime, nights 1-3.', '2-4 days.', 'VTID-02000-seed')
ON CONFLICT (condition_key) DO UPDATE
  SET display_label = EXCLUDED.display_label,
      description = EXCLUDED.description,
      recommended_ingredients = EXCLUDED.recommended_ingredients,
      recommended_health_goals = EXCLUDED.recommended_health_goals,
      contraindicated_ingredients = EXCLUDED.contraindicated_ingredients,
      contraindicated_with_conditions = EXCLUDED.contraindicated_with_conditions,
      contraindicated_with_medications = EXCLUDED.contraindicated_with_medications,
      evidence_level = EXCLUDED.evidence_level,
      typical_protocol = EXCLUDED.typical_protocol,
      typical_timeline = EXCLUDED.typical_timeline,
      updated_at = NOW(),
      version = public.condition_product_mappings.version + 1;

-- ===========================================================================
-- GEO POLICY — default flood filters (no Chinese products flooding EU/US feeds)
-- ===========================================================================

INSERT INTO public.geo_policy (user_region, rule_type, applies_to_origin, weight, user_opt_out_scope, description) VALUES
  ('EU',       'exclude_origin', 'APAC_CN', -1.0, 'international', 'Hide China-origin products from EU users (long delivery, customs). User can opt in via scope=international.'),
  ('EU',       'prefer_origin',  'EU',      0.3,  NULL,            'Boost EU-origin products for EU users (faster delivery, customs-free).'),
  ('EU',       'prefer_origin',  'UK',      0.1,  NULL,            'Slight boost for UK-origin products (neighbor market).'),
  ('US',       'exclude_origin', 'APAC_CN', -1.0, 'international', 'Hide China-origin products from US users unless scope=international.'),
  ('US',       'exclude_origin', 'EU',      -0.5, 'friendly',      'Deprioritize EU-origin products for US users (cross-Atlantic shipping / customs).'),
  ('US',       'prefer_origin',  'US',      0.3,  NULL,            'Boost US-origin products for US users.'),
  ('US',       'prefer_origin',  'CA',      0.15, NULL,            'Slight boost for Canadian-origin products (fast NAFTA-era delivery).'),
  ('UK',       'exclude_origin', 'APAC_CN', -1.0, 'international', 'Hide China-origin products from UK users unless scope=international.'),
  ('UK',       'prefer_origin',  'UK',      0.3,  NULL,            'Boost UK-origin products for UK users.'),
  ('UK',       'prefer_origin',  'EU',      0.1,  NULL,            'Slight boost for EU-origin products (near-market).'),
  ('MENA',     'exclude_origin', 'APAC_CN', -0.5, 'international', 'Deprioritize China-origin products for MENA users.'),
  ('MENA',     'prefer_origin',  'MENA',    0.3,  NULL,            'Boost MENA-origin products for MENA users.'),
  ('APAC_JP_KR_TW','prefer_origin','APAC_JP_KR_TW', 0.3, NULL,     'Boost Japan/Korea/Taiwan-origin products for users in those markets.'),
  ('OCEANIA',  'exclude_origin', 'APAC_CN', -0.3, 'international', 'Slight deprioritization of China-origin for Oceania users.'),
  ('OCEANIA',  'prefer_origin',  'OCEANIA', 0.3,  NULL,            'Boost Australia/NZ-origin products for Oceania users.')
ON CONFLICT DO NOTHING;

-- ===========================================================================
-- DEFAULT FEED CONFIG — 9 seed rows (EU × 4 stages + US × 4 stages + GLOBAL × onboarding)
-- ===========================================================================

INSERT INTO public.default_feed_config
  (tenant_id, region_group, lifecycle_stage, category_mix, max_products_per_merchant, starter_conditions, personalization_weight_override, diversity_rules, notes, updated_by)
VALUES
  -- EU
  (NULL, 'EU', 'onboarding',
   '{"supplements":0.4,"wellness-services":0.2,"devices":0.15,"skincare":0.15,"books":0.1}'::JSONB,
   3, ARRAY['insomnia','chronic-stress','low-energy'], 0.2,
   '{"interleave_categories":true,"min_price_variety":3,"origin_country_variety":true}'::JSONB,
   'Starter selection for new EU users. Broad category mix, stress/sleep/energy as universal starter conditions.', 'VTID-02000-seed'),

  (NULL, 'EU', 'early',
   '{"supplements":0.45,"wellness-services":0.2,"devices":0.15,"skincare":0.1,"books":0.1}'::JSONB,
   3, ARRAY['insomnia','chronic-stress','low-energy'], 0.45,
   '{"interleave_categories":true,"min_price_variety":2}'::JSONB,
   'Early EU user — 45% personalization once social / conversation signals exist.', 'VTID-02000-seed'),

  (NULL, 'EU', 'established',
   '{"supplements":0.5,"wellness-services":0.2,"devices":0.15,"skincare":0.1,"books":0.05}'::JSONB,
   4, ARRAY[]::TEXT[], 0.7,
   '{"interleave_categories":true}'::JSONB,
   'Established EU user — mostly personalized with some diversity safeguards.', 'VTID-02000-seed'),

  (NULL, 'EU', 'mature',
   '{"supplements":0.55,"wellness-services":0.2,"devices":0.15,"skincare":0.07,"books":0.03}'::JSONB,
   4, ARRAY[]::TEXT[], 0.9,
   '{"novelty_slot":0.1}'::JSONB,
   'Mature EU user — 90% personalization, 10% novelty/discovery.', 'VTID-02000-seed'),

  -- US
  (NULL, 'US', 'onboarding',
   '{"supplements":0.4,"wellness-services":0.2,"devices":0.2,"skincare":0.1,"books":0.1}'::JSONB,
   3, ARRAY['insomnia','chronic-stress','low-energy'], 0.2,
   '{"interleave_categories":true,"min_price_variety":3}'::JSONB,
   'Starter selection for new US users — device category slightly higher share reflecting US market.', 'VTID-02000-seed'),

  (NULL, 'US', 'early',
   '{"supplements":0.45,"wellness-services":0.2,"devices":0.2,"skincare":0.08,"books":0.07}'::JSONB,
   3, ARRAY['insomnia','chronic-stress','low-energy'], 0.45,
   '{"interleave_categories":true}'::JSONB,
   'Early US user — 45% personalization.', 'VTID-02000-seed'),

  (NULL, 'US', 'established',
   '{"supplements":0.5,"wellness-services":0.2,"devices":0.18,"skincare":0.08,"books":0.04}'::JSONB,
   4, ARRAY[]::TEXT[], 0.7,
   '{"interleave_categories":true}'::JSONB,
   'Established US user.', 'VTID-02000-seed'),

  (NULL, 'US', 'mature',
   '{"supplements":0.55,"wellness-services":0.2,"devices":0.18,"skincare":0.05,"books":0.02}'::JSONB,
   4, ARRAY[]::TEXT[], 0.9,
   '{"novelty_slot":0.1}'::JSONB,
   'Mature US user.', 'VTID-02000-seed'),

  -- GLOBAL (fallback for regions without explicit config)
  (NULL, 'GLOBAL', 'onboarding',
   '{"supplements":0.4,"wellness-services":0.2,"devices":0.15,"skincare":0.15,"books":0.1}'::JSONB,
   3, ARRAY['insomnia','chronic-stress','low-energy'], 0.2,
   '{"interleave_categories":true,"min_price_variety":3}'::JSONB,
   'Fallback config for regions without explicit onboarding defaults.', 'VTID-02000-seed')
ON CONFLICT (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::UUID), region_group, lifecycle_stage)
  WHERE is_active = TRUE
  DO UPDATE
    SET category_mix = EXCLUDED.category_mix,
        max_products_per_merchant = EXCLUDED.max_products_per_merchant,
        starter_conditions = EXCLUDED.starter_conditions,
        personalization_weight_override = EXCLUDED.personalization_weight_override,
        diversity_rules = EXCLUDED.diversity_rules,
        notes = EXCLUDED.notes,
        updated_at = NOW();
