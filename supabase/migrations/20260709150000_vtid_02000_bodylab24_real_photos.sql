-- VTID-02000 (Discover marketplace) — real Bodylab24 product photos.
--
-- Context: the 4 Bodylab24 products already got real per-product deeplinks
-- in the earlier migration (20260709120000), but still used generic, reused
-- Unsplash stock photos for images. Bodylab24 has no bulk Admitad product
-- feed (single-merchant, deeplink-only program) and this sandbox's WebFetch
-- is blocked by bot protection on bodylab24.de, so there is no automated
-- path to real photos. The operator manually copied each product's real
-- main-image URL directly from its bodylab24.de page (Shopify CDN, publicly
-- hotlinkable) and provided them for this migration.
--
-- impact-allow-solo-migration: data-only migration, no code path changes
-- required — ProductImage.tsx already renders whatever URL is in
-- products.images[0].

BEGIN;

UPDATE products SET images = ARRAY['https://www.bodylab24.de/cdn/shop/files/1-bodylab-omega-3-120kapseln-int.png?v=1768464407&width=720']::text[], updated_at = now() WHERE id = 'd15c0000-0000-4000-8000-000000000009';
UPDATE products SET images = ARRAY['https://www.bodylab24.de/cdn/shop/files/1-bodylab-magnesium-bis-120c-iml0.5-2025_1.png?v=1767794723&width=720']::text[], updated_at = now() WHERE id = 'd15c0000-0000-4000-8000-00000000000a';
UPDATE products SET images = ARRAY['https://www.bodylab24.de/cdn/shop/files/2-box-bodylab-premium-health-vitamin-d3_k2-oil.png?v=1775059318&width=720']::text[], updated_at = now() WHERE id = 'd15c0000-0000-4000-8000-00000000000b';
UPDATE products SET images = ARRAY['https://www.bodylab24.de/cdn/shop/files/1-bodylab-vitamine-b-complex-120t-iml0.5-2025.png?v=1767794717&width=720']::text[], updated_at = now() WHERE id = 'd15c0000-0000-4000-8000-00000000000c';

COMMIT;

-- =====================================================================================
-- DOWN (rollback) — not meaningful to restore the old Unsplash placeholders;
-- if ever needed, re-run the original seed migration
-- 20260629120000_vtid_02000_discover_admitad_real_catalog.sql's images arrays.
-- =====================================================================================
