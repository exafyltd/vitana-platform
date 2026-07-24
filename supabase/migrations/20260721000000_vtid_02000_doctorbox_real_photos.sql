-- VTID-02000 (Discover marketplace) — DoctorBox: replace placeholder Unsplash
-- images with real per-product photos.
--
-- Round 3 fix: the seed migration's placeholder pool (9 generic Unsplash
-- stock photos, shuffled with no category logic across all 53 products) was
-- flagged by the user as looking "terrible" — e.g. a raw-salmon photo shown
-- on the cardio "Herz-Kreislauf Check" product. Same root cause and same fix
-- pattern as Bodylab24's own upgrade (20260709150000_vtid_02000_bodylab24_real_photos.sql):
-- real image URLs sourced directly from the merchant, not a better-curated
-- placeholder set.
--
-- Source: shop.doctorbox.de blocks automated fetching (403, confirmed again
-- this session), so these 53 URLs were gathered by the user from the Shopify
-- Collabs "Instantly share products" grid (DoctorBox Heimtests products) —
-- right-click "Copy image address" on each thumbnail yields a direct Shopify
-- CDN URL (shop.doctorbox.de/cdn/shop/files/...) that is NOT behind the same
-- bot-protection as the storefront pages. Confirmed via filename-to-title
-- matches and price/value-count screenshots for every ambiguous case.
--
-- Notes on specific rows (flagged during gathering, not identical mismatches
-- like the original salmon photo — all confirmed correct or clearly benign):
--   - 6 products (ids ...0007, ...0008, ...0012, ...0014, ...001c, ...002e)
--     share one generic "Probenahme-Set" (sample-kit) box photo — confirmed
--     via price/value-count screenshots that DoctorBox's own storefront uses
--     this same generic shot for these products (no distinct photography
--     exists for them), not a mismatch.
--   - 3 products (...0001, ...0003, ...0006) matched by DE/EN title
--     translation (our DB stored an English title, storefront shows German)
--     — high-confidence name match, not independently price-verified.
--   - 1 product (...002f, "Fettstoffwechsel Analyse") has a source filename
--     ("Fettsaeuren_Analyse") that doesn't exactly match our DB title —
--     conceptually adjacent (cholesterol/triglycerides), flagged for a
--     follow-up sanity check but not held back from this batch.
--
-- No gateway/frontend code change needed: ProductImage.tsx
-- (vitana-v1/src/components/discover/ProductImage.tsx) renders whatever URL
-- sits in products.images[0] directly, same as every other merchant.
--
-- impact-allow-solo-migration: data-only image update, fully consumed by
-- existing ProductImage.tsx rendering — no schema or code change.

BEGIN;

UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/NaehrstoffCheckPremium-Shopify.png?v=1776160916&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000001';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/FitnessCheckPro.webp?v=1774879960&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000002';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/VitaminRundumCheck-Shopify.png?v=1776161312&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000003';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/VitaminD-Shopify.png?v=1776160416&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000004';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/VitaminB12-Shopify.png?v=1776159947&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000005';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/NaehrstoffRundumCheck-Shopify.png?v=1776159361&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000006';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/Probenahme-Set-Deutsch.png?v=1774880217&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000007';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/Probenahme-Set-Deutsch.png?v=1774880217&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000008';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/HormonCheckfuerMaenner.png?v=1776156675&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000009';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/FruchtbarkeitsCheckfuerFrauen.webp?v=1774883043&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000000a';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/TestosteronTest.webp?v=1774884024&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000000b';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/SchilddruesenCheckPlus.webp?v=1774882805&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000000c';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/HormonCheckfuerFrauen-Hormone.webp?v=1774943358&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000000d';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/RundumCheckfuerMaenner-Shopify.png?v=1777452531&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000000e';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/Abnehmen-Set-Shopify.png?v=1776156353&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000000f';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/StoffwechselCheckPlus.png?v=1774879538&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000010';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/Herz-Kreislauf-Shopify.png?v=1776156574&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000011';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/Probenahme-Set-Deutsch.png?v=1774880217&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000012';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/RundumCheckfuerFrauen_3503a77b-2dff-4f91-8e36-62363de39dcf.png?v=1774879338&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000013';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/Probenahme-Set-Deutsch.png?v=1774880217&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000014';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/LipidCheck_5a0a56fe-4373-4a86-84b4-aba6ea27c346.png?v=1776157195&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000015';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/CortisolCheck-Longevity_Fitness.webp?v=1774944585&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000016';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/BioAgeTest-Shopify.png?v=1779799759&width=493']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000017';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/NeuroVitalCheck.webp?v=1774880217&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000018';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/HPV_HighRisk_-Frueherkennung.webp?v=1774940020&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000019';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/Vaginalpilz-Shopify.png?v=1776166670&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000001a';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/Personalisierte_Darmkrebspraevention.jpg?v=1767961039&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000001b';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/Probenahme-Set-Deutsch.png?v=1774880217&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000001c';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/Personalisierte_Melanompraevention_1.png?v=1767961665&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000001d';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/STITriofuerFrauen-Shopify.png?v=1775808558&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000001e';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/Brustkrebs_Antegenes_1.jpg?v=1767960677&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000001f';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/STIPro-Shopify.png?v=1775806219&width=493']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000020';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/STITriofuerMaenner-Shopify.png?v=1775808061&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000021';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/STIStandard-Shopify_1.png?v=1775806659&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000022';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/STIBasic-Shopify_1.png?v=1775806925&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000023';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/STISelect-Shopify.png?v=1775807444&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000024';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/STIEssential-Shopify_1_a7f533fd-6a50-4cf4-93f1-faacfd8d8bdf.png?v=1775807151&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000025';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/Darmkrebsvorsorge-Frueherkennung.webp?v=1774939797&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000026';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/PSAProstataspezifischesAntigent-Frueherkennung.webp?v=1774940320&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000027';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/BlutzuckerTest-Frueherkennung_003b18be-598a-4677-aff8-dd550add7ca0.webp?v=1774944028&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000028';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/LeberCheck-Shopify.png?v=1776159076&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000029';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/coloAlert-Startbild_1.jpg?v=1768904638&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000002a';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/LeakyGut-Shopify_7fdd05fe-b5c6-459c-99c2-53ccd56ce4a3.png?v=1778065362&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000002b';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/AllergietestShopify.png?v=1768918718&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000002c';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/AminosaeurenprofilStartbild.jpg?v=1760355453&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000002d';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/Probenahme-Set-Deutsch.png?v=1774880217&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000002e';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/Fettsaeuren_Analyse_Shopify.png?v=1780647444&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000002f';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/VOC-IMOTestStartbild.png?v=1767962428&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000030';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/Personalisierte_Krebspraevention_Frauen.png?v=1767961376&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000031';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/Personalisierte_Krebspraevention_Maenner_2.png?v=1767961336&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000032';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/Personalisierte_Prostatakrebspraevention_2.png?v=1767961594&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000033';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/COFFEEGEN_Startbild_1.png?v=1767961779&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000034';
UPDATE products SET images = ARRAY['https://shop.doctorbox.de/cdn/shop/files/biologisches-alter-test.png?v=1720451808&width=600']::text[], updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000035';

COMMIT;

-- =====================================================================================
-- DOWN (rollback): re-apply the original placeholder Unsplash images from
-- 20260717120000_vtid_02000_discover_doctorbox_seed.sql — not scripted here
-- since the correct rollback is simply re-running that seed migration's
-- INSERT ... ON CONFLICT DO UPDATE for the `images` column, which this
-- migration does not otherwise touch.
-- =====================================================================================
