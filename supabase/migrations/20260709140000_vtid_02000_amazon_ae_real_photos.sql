-- VTID-02000 (Discover marketplace) — real Amazon.ae product photos.
--
-- Context: the 8 hand-seeded Amazon.ae products had real, product-specific
-- affiliate deeplinks (/dp/<ASIN>) but generic, reused Unsplash stock photos
-- for images. Amazon's PA-API (which would pull real photos automatically)
-- requires the Associate account to clear >=3 qualifying sales in the last
-- 180 days — not yet met, so PA-API is not usable. The operator manually
-- copied each product's real main-image URL from its amazon.ae page
-- (m.media-amazon.com CDN, publicly hotlinkable) and provided them here.
--
-- impact-allow-solo-migration: data-only migration, no code path changes
-- required — ProductImage.tsx already renders whatever URL is in
-- products.images[0].

BEGIN;

UPDATE products SET images = ARRAY['https://m.media-amazon.com/images/I/61ZWok6-hML._AC_SX679_.jpg']::text[], updated_at = now() WHERE id = 'a42d0000-0000-4000-8000-000000000001';
UPDATE products SET images = ARRAY['https://m.media-amazon.com/images/I/61v++PCY0jL._AC_SX679_.jpg']::text[], updated_at = now() WHERE id = 'a42d0000-0000-4000-8000-000000000002';
UPDATE products SET images = ARRAY['https://m.media-amazon.com/images/I/71sLv+c8aEL._AC_SY300_SX300_QL70_ML2_.jpg']::text[], updated_at = now() WHERE id = 'a42d0000-0000-4000-8000-000000000003';
UPDATE products SET images = ARRAY['https://m.media-amazon.com/images/I/616peIEfAaL._AC_SY300_SX300_QL70_ML2_.jpg']::text[], updated_at = now() WHERE id = 'a42d0000-0000-4000-8000-000000000004';
UPDATE products SET images = ARRAY['https://m.media-amazon.com/images/I/613X44S3EaL._AC_SY300_SX300_QL70_ML2_.jpg']::text[], updated_at = now() WHERE id = 'a42d0000-0000-4000-8000-000000000005';
UPDATE products SET images = ARRAY['https://m.media-amazon.com/images/I/71HPhwBc+7L._AC_SY300_SX300_QL70_ML2_.jpg']::text[], updated_at = now() WHERE id = 'a42d0000-0000-4000-8000-000000000006';
UPDATE products SET images = ARRAY['https://m.media-amazon.com/images/I/61bnuqDhPLL._AC_SY300_SX300_QL70_ML2_.jpg']::text[], updated_at = now() WHERE id = 'a42d0000-0000-4000-8000-000000000007';
UPDATE products SET images = ARRAY['https://m.media-amazon.com/images/I/613-ko7VZyL._AC_SY300_SX300_QL70_ML2_.jpg']::text[], updated_at = now() WHERE id = 'a42d0000-0000-4000-8000-000000000008';

COMMIT;

-- =====================================================================================
-- DOWN (rollback) — not meaningful to restore the old Unsplash placeholders;
-- if ever needed, re-run the original seed migration
-- 20260702120000_vtid_02000_amazon_ae_recommendations_seed.sql's images arrays.
-- =====================================================================================
