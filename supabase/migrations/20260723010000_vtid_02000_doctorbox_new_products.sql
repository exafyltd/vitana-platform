-- VTID-02000 (Discover marketplace) — DoctorBox catalog: 11 new products
-- discovered while gathering per-product deep links (see the sibling
-- migration 20260723000000_..._doctorbox_per_product_deeplinks.sql).
--
-- While copying deep links from the Shopify Collabs grid, several cards
-- didn't match any of the original 53 products by name/price/value-panel —
-- confirmed as genuinely new SKUs added to DoctorBox's catalog since the
-- initial seed (20260717120000), not renames (renames were cross-checked via
-- price/branding and are covered by the sibling migration instead):
--
--   1. Cardio & Vital-Check (health-tests/cardio) — broader cardio/metabolic
--      panel than Herz-Kreislauf Check, distinct price (EUR 110 vs EUR 89)
--      and value panel (8 vs different values).
--   2. Nierenfunktion (UACR Analyse) (health-tests/prevention) — urine-based
--      albumin/creatinine ratio test, distinct from the existing Nieren
--      Profil (blood-based, 5 values, EUR 69).
--   3. OsteoTest für zu Hause (health-tests/prevention) — urine-based
--      osteoporosis-risk screening (osteolabs brand), box marked "NEU".
--   4. STI Standard – 4er Bundle (health-tests/sexual-health) — separate
--      4-pack bundle SKU of the existing STI Standard test, distinctly
--      priced/positioned ("für Gruppen und Paare").
--   5. Burnout Stress Check (health-tests/general-health).
--   6. Müdigkeits-Check (health-tests/general-health).
--   7-9, 11. Vitamin D3 biomo® — 4 supplement SKUs (120/60-tablet, 90-capsule
--      vegan, and drops), a different product TYPE entirely (nutritional
--      supplement, not a diagnostic test) — seeded under category=
--      'supplements', subcategory='vitamins' (existing, already wired into
--      CategoryShopSections.tsx/CategoryProducts.tsx — confirmed via direct
--      code read, no frontend change needed). Brand is the actual
--      manufacturer ("biomo"), not DoctorBox itself.
--  10. Notfallsticker — a QR-code emergency medical info sticker/card, not a
--      test or supplement at all. No existing category fits cleanly
--      (confirmed via querying distinct categories: supplements, skincare,
--      health-tests, lifestyle, plus unrelated dropshipping categories) —
--      seeded under category='lifestyle' as the closest available fit, no
--      new subcategory taxonomy or frontend wiring added for it.
--
-- Real product photos (Shopify CDN) and per-product Shopify Collabs deep
-- links were gathered directly for all 11 at creation time — none of these
-- start on the Unsplash-placeholder/shared-link pattern the original 53 did.
--
-- Not fabricated: rating/review_count left NULL, same as every other
-- DoctorBox product.
--
-- impact-allow-solo-migration: intentional data-only migration, no gateway/
-- worker code touch needed.

BEGIN;

INSERT INTO products (
  id, merchant_id, source_network, source_product_id, title, description, description_long,
  brand, category, subcategory, price_cents, compare_at_price_cents, currency, images,
  affiliate_url, availability, rating, review_count, origin_country, origin_region,
  ships_to_countries, ships_to_regions, health_goals, dietary_tags, ingredients_primary,
  topic_keys, reward_preview, is_active, requires_admin_review
) VALUES

  ('d0c70000-0000-4000-8000-000000000036', 'd0c706b0-0000-4000-8000-000000000001', 'doctorbox',
   'doctorbox-cardio-vital-check', 'Cardio & Vital-Check',
   'Für alle, die ihre Gesundheit ganzheitlich überprüfen möchten – besonders bei Müdigkeit, unausgewogener Ernährung, erhöhtem Herz-Kreislauf-Risiko oder zur allgemeinen Vorsorge.',
   'Der Cardio & Vital-Check analysiert 8 zentrale Blutwerte für Herz-Kreislauf- und Vitalgesundheit. 8 analysierte Werte, Probenart: Blut.',
   'DoctorBox', 'health-tests', 'cardio', 11000, NULL, 'EUR',
   ARRAY['https://cdn.shopify.com/s/files/1/0564/6991/3683/files/Tasso_ohne_text.jpg?v=1773752734&width=283&height=283&crop=center']::text[],
   'https://collabs.shop/ir8pzz', 'in_stock', NULL, NULL, 'DE', 'EU',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[], ARRAY['EU','UK']::text[],
   ARRAY['cardio-health','longevity']::text[], ARRAY[]::text[], ARRAY[]::text[],
   ARRAY['diagnostics','self-testing','cardio','cholesterol','lipids']::text[],
   '{"points_estimate": 550, "currency": "EUR"}'::jsonb, true, false),

  ('d0c70000-0000-4000-8000-000000000037', 'd0c706b0-0000-4000-8000-000000000001', 'doctorbox',
   'doctorbox-nierenfunktion-uacr', 'Nierenfunktion (UACR Analyse)',
   'Ermittelt das Eiweiß-Verhältnis im Urin, um beginnende Nierenschäden frühzeitig zu erkennen. Dient vor allem Menschen mit Diabetes oder Bluthochdruck zur einfachen und regelmäßigen Vorsorge.',
   'Die UACR-Analyse misst Albumin, Kreatinin und den Urin-Albumin-Kreatinin-Quotienten. 3 analysierte Werte, Probenart: Urin.',
   'DoctorBox', 'health-tests', 'prevention', 9900, NULL, 'EUR',
   ARRAY['https://shop.doctorbox.de/cdn/shop/files/UACRTestShopify.png?v=1779955707&width=493']::text[],
   'https://collabs.shop/hfhsod', 'in_stock', NULL, NULL, 'DE', 'EU',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[], ARRAY['EU','UK']::text[],
   ARRAY['kidney-health','prevention']::text[], ARRAY[]::text[], ARRAY[]::text[],
   ARRAY['diagnostics','self-testing','kidney','urine-test']::text[],
   '{"points_estimate": 495, "currency": "EUR"}'::jsonb, true, false),

  ('d0c70000-0000-4000-8000-000000000038', 'd0c706b0-0000-4000-8000-000000000001', 'doctorbox',
   'doctorbox-osteotest-zu-hause', 'OsteoTest für zu Hause',
   'Frühe Risikobestimmung von Knochencalciumverlust – bequem von zu Hause aus, ohne Röntgen, ohne Praxisbesuch.',
   'Der OsteoTest | home analysiert Calcium-Isotope im Urin mittels Massenspektrometer und erkennt Veränderungen des Knochenstoffwechsels, bevor sie im Röntgenbild sichtbar werden. 1 analysierter Wert, Probenart: Urin (morgens, nüchtern). Marke: osteolabs.',
   'DoctorBox', 'health-tests', 'prevention', 9900, NULL, 'EUR',
   ARRAY['https://shop.doctorbox.de/cdn/shop/files/OsteoTest_1.jpg?v=1767962596&width=493']::text[],
   'https://collabs.shop/tva5ts', 'in_stock', NULL, NULL, 'DE', 'EU',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[], ARRAY['EU','UK']::text[],
   ARRAY['bone-health','prevention']::text[], ARRAY[]::text[], ARRAY[]::text[],
   ARRAY['diagnostics','self-testing','osteoporosis','bone-health','urine-test']::text[],
   '{"points_estimate": 495, "currency": "EUR"}'::jsonb, true, false),

  ('d0c70000-0000-4000-8000-000000000039', 'd0c706b0-0000-4000-8000-000000000001', 'doctorbox',
   'doctorbox-sti-standard-4er-bundle', 'STI Standard – 4er Bundle',
   'STI Standard für Gruppen und Paare – überprüft auf die 5 häufigsten STIs, im praktischen 4er-Bundle.',
   'Bundle aus 4 STI-Standard-Tests. Analysierte Werte: Chlamydien, Gonorrhö (Tripper), HIV, Syphilis, Hepatitis C. Probenart: Urin & Trockenblut.',
   'DoctorBox', 'health-tests', 'sexual-health', 25600, 32000, 'EUR',
   ARRAY['https://shop.doctorbox.de/cdn/shop/files/4erBundleSTIStandard.png?v=1769445301&width=600']::text[],
   'https://collabs.shop/sbpgr7', 'in_stock', NULL, NULL, 'DE', 'EU',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[], ARRAY['EU','UK']::text[],
   ARRAY['sexual-health','group-testing']::text[], ARRAY[]::text[], ARRAY[]::text[],
   ARRAY['diagnostics','self-testing','sti','sexual-health','bundle','group-testing']::text[],
   '{"points_estimate": 1280, "currency": "EUR"}'::jsonb, true, false),

  ('d0c70000-0000-4000-8000-00000000003a', 'd0c706b0-0000-4000-8000-000000000001', 'doctorbox',
   'doctorbox-burnout-stress-check', 'Burnout Stress Check',
   'Zeigt anhand zentraler Blutwerte dein Stressniveau und mögliche Nährstoffdefizite.',
   'Der Burnout Stress Check analysiert Cortisol, TSH (sensitiv), Magnesium, Hämoglobin, Folsäure und Transcobalamin. 6 analysierte Werte, Probenart: Kapillarblut.',
   'DoctorBox', 'health-tests', 'general-health', 12500, NULL, 'EUR',
   ARRAY['https://shop.doctorbox.de/cdn/shop/files/Probenahme-Set-Deutsch.png?v=1774880217&width=600']::text[],
   'https://collabs.shop/dw2it1', 'in_stock', NULL, NULL, 'DE', 'EU',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[], ARRAY['EU','UK']::text[],
   ARRAY['stress-reduction','burnout-recovery']::text[], ARRAY[]::text[], ARRAY[]::text[],
   ARRAY['diagnostics','self-testing','stress','burnout','cortisol']::text[],
   '{"points_estimate": 625, "currency": "EUR"}'::jsonb, true, false),

  ('d0c70000-0000-4000-8000-00000000003b', 'd0c706b0-0000-4000-8000-000000000001', 'doctorbox',
   'doctorbox-vitamin-d3-biomo-120-tabletten', 'Vitamin D3 biomo® 2.000 I.E. - 120 Tabletten',
   'Nahrungsergänzungsmittel mit Vitamin D3. Unterstützt das Immunsystem und ist wichtig für den Erhalt normaler Knochen und Muskeln.',
   'Vitamin D3 biomo® 2.000 I.E., 120 Tabletten. Unterstützt Immunsystem, Knochen, Muskelfunktion, Calcium-/Phosphor-Aufnahme und Zahngesundheit. Laktosefrei, glutenfrei. Dosierung: Erwachsene/Kinder ab 11 Jahren bis 2 Tabletten/Tag, unter 10 Jahren 1 Tablette/Tag.',
   'biomo', 'supplements', 'vitamins', 1645, NULL, 'EUR',
   ARRAY['https://shop.doctorbox.de/cdn/shop/files/VitaminD32.000I.E.TablettenNEM2048x2048.jpg?v=1729000330&width=600']::text[],
   'https://collabs.shop/uasv5g', 'in_stock', NULL, NULL, 'DE', 'EU',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[], ARRAY['EU','UK']::text[],
   ARRAY['vitamin-d','immunity','bone-health']::text[], ARRAY[]::text[], ARRAY['Cholecalciferol (Vitamin D3)']::text[],
   ARRAY['supplement','vitamin-d','immunity','bone-health']::text[],
   '{"points_estimate": 82, "currency": "EUR"}'::jsonb, true, false),

  ('d0c70000-0000-4000-8000-00000000003c', 'd0c706b0-0000-4000-8000-000000000001', 'doctorbox',
   'doctorbox-vitamin-d3-biomo-vegan-90-kapseln', 'Vitamin D3 biomo® 2.000 I.E. (vegan) - 90 Kapseln',
   'Nahrungsergänzungsmittel mit Vitamin D3, vegane Kapselvariante. Unterstützt das Immunsystem und ist wichtig für den Erhalt normaler Knochen und Muskeln.',
   'Vitamin D3 biomo® 2.000 I.E., vegan, 90 Kapseln. Gleiches Wirkprofil wie die Tabletten-Variante (Immunsystem, Knochen, Muskeln).',
   'biomo', 'supplements', 'vitamins', 1449, NULL, 'EUR',
   ARRAY['https://shop.doctorbox.de/cdn/shop/files/VitaminD32.000I.E.KapselnNEM2048x2048.jpg?v=1729000167&width=600']::text[],
   'https://collabs.shop/qp05gp', 'in_stock', NULL, NULL, 'DE', 'EU',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[], ARRAY['EU','UK']::text[],
   ARRAY['vitamin-d','immunity','bone-health']::text[], ARRAY['vegan']::text[], ARRAY['Cholecalciferol (Vitamin D3)']::text[],
   ARRAY['supplement','vitamin-d','immunity','bone-health','vegan']::text[],
   '{"points_estimate": 72, "currency": "EUR"}'::jsonb, true, false),

  ('d0c70000-0000-4000-8000-00000000003d', 'd0c706b0-0000-4000-8000-000000000001', 'doctorbox',
   'doctorbox-vitamin-d3-biomo-60-tabletten', 'Vitamin D3 biomo® 2.000 I.E. - 60 Tabletten',
   'Nahrungsergänzungsmittel mit Vitamin D3. Unterstützt das Immunsystem und ist wichtig für den Erhalt normaler Knochen und Muskeln.',
   'Vitamin D3 biomo® 2.000 I.E., 60 Tabletten (kleinere Packungsgröße der 120er-Variante).',
   'biomo', 'supplements', 'vitamins', 895, NULL, 'EUR',
   ARRAY['https://shop.doctorbox.de/cdn/shop/files/VitaminD32.000I.E.TablettenNEM2048x2048.jpg?v=1729000330&width=600']::text[],
   'https://collabs.shop/gwnuqr', 'in_stock', NULL, NULL, 'DE', 'EU',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[], ARRAY['EU','UK']::text[],
   ARRAY['vitamin-d','immunity','bone-health']::text[], ARRAY[]::text[], ARRAY['Cholecalciferol (Vitamin D3)']::text[],
   ARRAY['supplement','vitamin-d','immunity','bone-health']::text[],
   '{"points_estimate": 45, "currency": "EUR"}'::jsonb, true, false),

  ('d0c70000-0000-4000-8000-00000000003e', 'd0c706b0-0000-4000-8000-000000000001', 'doctorbox',
   'doctorbox-muedigkeits-check', 'Müdigkeits-Check',
   'Untersucht 6 wichtige Blutwerte, die Aufschluss über Energiehaushalt, Stressbelastung, Hormonbalance und mögliche Nährstoffdefizite geben.',
   'Der Müdigkeits-Check misst 25-OH-Vitamin D3, Vitamin B12, SHBG, Cortisol, Harnsäure und Folsäure. 6 analysierte Werte, Probenart: Kapillarblut.',
   'DoctorBox', 'health-tests', 'general-health', 9900, NULL, 'EUR',
   ARRAY['https://shop.doctorbox.de/cdn/shop/files/Probenahme-Set-Deutsch.png?v=1774880217&width=600']::text[],
   'https://collabs.shop/yyigx3', 'in_stock', NULL, NULL, 'DE', 'EU',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[], ARRAY['EU','UK']::text[],
   ARRAY['energy','fatigue-recovery']::text[], ARRAY[]::text[], ARRAY[]::text[],
   ARRAY['diagnostics','self-testing','fatigue','energy','vitamins']::text[],
   '{"points_estimate": 495, "currency": "EUR"}'::jsonb, true, false),

  ('d0c70000-0000-4000-8000-00000000003f', 'd0c706b0-0000-4000-8000-000000000001', 'doctorbox',
   'doctorbox-vitamin-d3-biomo-tropfen', 'Vitamin D3 biomo® Tropfen - Anpassbare Dosierung',
   'Nahrungsergänzungsmittel mit Vitamin D3 in Tropfenform, individuell dosierbar.',
   'Vitamin D3 biomo® Tropfen, 500 I.E. pro Tropfen, anpassbare Dosierung.',
   'biomo', 'supplements', 'vitamins', 949, NULL, 'EUR',
   ARRAY['https://shop.doctorbox.de/cdn/shop/files/VitaminD32.000I.E.TropfenNEM2048x2048.jpg?v=1729000488&width=600']::text[],
   'https://collabs.shop/tmgc6g', 'in_stock', NULL, NULL, 'DE', 'EU',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[], ARRAY['EU','UK']::text[],
   ARRAY['vitamin-d','immunity','bone-health']::text[], ARRAY[]::text[], ARRAY['Cholecalciferol (Vitamin D3)']::text[],
   ARRAY['supplement','vitamin-d','immunity','bone-health','drops']::text[],
   '{"points_estimate": 47, "currency": "EUR"}'::jsonb, true, false),

  ('d0c70000-0000-4000-8000-000000000040', 'd0c706b0-0000-4000-8000-000000000001', 'doctorbox',
   'doctorbox-notfallsticker', 'Notfallsticker',
   'QR-Code Notfallsticker für Smartphone & Geldbeutel – verlinkt auf deine digitale Notfall-Patientenakte.',
   'Notfallsticker mit QR-Code für Smartphone und Karten für den Geldbeutel, verlinkt auf eine digitale Notfall-Patientenakte mit wichtigen medizinischen Informationen.',
   'DoctorBox', 'lifestyle', 'safety', 999, NULL, 'EUR',
   ARRAY['https://cdn.shopify.com/s/files/1/0564/6991/3683/files/MicrosoftTeams-image_169.png?v=1720451843&width=283&height=283&crop=center']::text[],
   'https://collabs.shop/hjleke', 'in_stock', NULL, NULL, 'DE', 'EU',
   ARRAY['DE','AT','CH','FR','IT','ES','NL','BE','PL','SE','DK','FI','GB','IE']::text[], ARRAY['EU','UK']::text[],
   ARRAY['safety','emergency-preparedness']::text[], ARRAY[]::text[], ARRAY[]::text[],
   ARRAY['safety','emergency','medical-id','qr-code']::text[],
   '{"points_estimate": 50, "currency": "EUR"}'::jsonb, true, false)

ON CONFLICT (source_network, source_product_id) DO UPDATE
  SET title = EXCLUDED.title, description = EXCLUDED.description, description_long = EXCLUDED.description_long,
      brand = EXCLUDED.brand, category = EXCLUDED.category, subcategory = EXCLUDED.subcategory,
      price_cents = EXCLUDED.price_cents, compare_at_price_cents = EXCLUDED.compare_at_price_cents,
      images = EXCLUDED.images, affiliate_url = EXCLUDED.affiliate_url,
      health_goals = EXCLUDED.health_goals, dietary_tags = EXCLUDED.dietary_tags,
      ingredients_primary = EXCLUDED.ingredients_primary, topic_keys = EXCLUDED.topic_keys,
      reward_preview = EXCLUDED.reward_preview, is_active = true, updated_at = now();

COMMIT;
