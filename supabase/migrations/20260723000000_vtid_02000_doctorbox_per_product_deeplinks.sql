-- VTID-02000 (Discover marketplace) — DoctorBox per-product affiliate deep links.
--
-- Replaces the single shared affiliate_url ('https://shop.doctorbox.de/VITANALAND',
-- used for all 53 products since the initial seed) with 53 individual Shopify
-- Collabs deep links (https://collabs.shop/xxxxxx), one per product. This was
-- already flagged as a future option in the original seed migration's header
-- comment (per-product deep-linking confirmed supported and tested there).
--
-- Why: with one shared link, DoctorBox purchases can never be attributed back
-- to a specific product or a specific Vitana user's click/recommendation —
-- Awin's automated order sync works because each click gets a unique clickref
-- token; a shared link can't support that even in principle. Per-product deep
-- links are a prerequisite for any future order/attribution sync (still
-- blocked separately on DoctorBox granting Shopify Admin API order-read
-- access — see conversation history, not a code change). This migration only
-- fixes the Vitana-side half of that gap.
--
-- Links gathered manually from the Shopify Collabs "DoctorBox Heimtests
-- products" grid (same dashboard used to source the real product photos in
-- 20260721000000_..._doctorbox_real_photos.sql) — the storefront itself
-- remains bot-protected (403 to automated fetch), so this required the same
-- manual-copy method. All 53 links tap-tested by the source of the original
-- catalog; 1 (AntePC / "Prostatakrebs Risiko Test") was inferred from the
-- naming pattern shared by 5 other confirmed Ante*-branded renames rather
-- than visually re-confirmed — flagging here in case it needs a follow-up
-- correction.
--
-- No gateway/frontend code change required: click-redirect.ts already reads
-- `products.affiliate_url` per row (not a merchant-level field), and
-- stampAffiliateUrl() is host-agnostic — confirmed via direct code read.
--
-- impact-allow-solo-migration: intentional data-only migration, no gateway/
-- worker code touch needed.

BEGIN;

UPDATE products SET affiliate_url = 'https://collabs.shop/7iepsg', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000001';
UPDATE products SET affiliate_url = 'https://collabs.shop/kq8gl4', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000002';
UPDATE products SET affiliate_url = 'https://collabs.shop/8qalyh', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000003';
UPDATE products SET affiliate_url = 'https://collabs.shop/krdijy', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000004';
UPDATE products SET affiliate_url = 'https://collabs.shop/nfob8g', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000005';
UPDATE products SET affiliate_url = 'https://collabs.shop/pcomtf', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000006';
UPDATE products SET affiliate_url = 'https://collabs.shop/cvjftp', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000007';
UPDATE products SET affiliate_url = 'https://collabs.shop/wotexb', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000008';
UPDATE products SET affiliate_url = 'https://collabs.shop/alh1rr', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000009';
UPDATE products SET affiliate_url = 'https://collabs.shop/2uxi1q', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000000a';
UPDATE products SET affiliate_url = 'https://collabs.shop/hccam9', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000000b';
UPDATE products SET affiliate_url = 'https://collabs.shop/4aj95i', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000000c';
UPDATE products SET affiliate_url = 'https://collabs.shop/guv9fd', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000000d';
UPDATE products SET affiliate_url = 'https://collabs.shop/uqfhwp', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000000e';
UPDATE products SET affiliate_url = 'https://collabs.shop/zncv4v', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000000f';
UPDATE products SET affiliate_url = 'https://collabs.shop/pvcmc8', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000010';
UPDATE products SET affiliate_url = 'https://collabs.shop/ztu8m1', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000011';
UPDATE products SET affiliate_url = 'https://collabs.shop/qckyvl', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000012';
UPDATE products SET affiliate_url = 'https://collabs.shop/qay7od', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000013';
UPDATE products SET affiliate_url = 'https://collabs.shop/gxgqp9', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000014';
UPDATE products SET affiliate_url = 'https://collabs.shop/gozsnt', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000015';
UPDATE products SET affiliate_url = 'https://collabs.shop/zzkxgn', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000016';
UPDATE products SET affiliate_url = 'https://collabs.shop/uxh78t', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000017';
UPDATE products SET affiliate_url = 'https://collabs.shop/o11dkt', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000018';
UPDATE products SET affiliate_url = 'https://collabs.shop/glub7a', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000019';
UPDATE products SET affiliate_url = 'https://collabs.shop/jzerrc', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000001a';
UPDATE products SET affiliate_url = 'https://collabs.shop/pnecwc', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000001b';
UPDATE products SET affiliate_url = 'https://collabs.shop/mkrwdt', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000001c';
UPDATE products SET affiliate_url = 'https://collabs.shop/jrml1j', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000001d';
UPDATE products SET affiliate_url = 'https://collabs.shop/jtvmu2', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000001e';
UPDATE products SET affiliate_url = 'https://collabs.shop/ydcrue', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000001f';
UPDATE products SET affiliate_url = 'https://collabs.shop/m4bvkv', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000020';
UPDATE products SET affiliate_url = 'https://collabs.shop/7pmfw9', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000021';
UPDATE products SET affiliate_url = 'https://collabs.shop/qezwvt', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000022';
UPDATE products SET affiliate_url = 'https://collabs.shop/lxbekg', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000023';
UPDATE products SET affiliate_url = 'https://collabs.shop/fpoaz7', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000024';
UPDATE products SET affiliate_url = 'https://collabs.shop/qbmfn5', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000025';
UPDATE products SET affiliate_url = 'https://collabs.shop/ritqd6', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000026';
UPDATE products SET affiliate_url = 'https://collabs.shop/zp9b3p', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000027';
UPDATE products SET affiliate_url = 'https://collabs.shop/gjvper', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000028';
UPDATE products SET affiliate_url = 'https://collabs.shop/eafhdl', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000029';
UPDATE products SET affiliate_url = 'https://collabs.shop/ksp7zd', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000002a';
UPDATE products SET affiliate_url = 'https://collabs.shop/2hwtkc', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000002b';
UPDATE products SET affiliate_url = 'https://collabs.shop/rwxt4z', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000002c';
UPDATE products SET affiliate_url = 'https://collabs.shop/5gby0v', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000002d';
UPDATE products SET affiliate_url = 'https://collabs.shop/bjvejk', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000002e';
UPDATE products SET affiliate_url = 'https://collabs.shop/dfric2', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-00000000002f';
UPDATE products SET affiliate_url = 'https://collabs.shop/rzvejj', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000030';
UPDATE products SET affiliate_url = 'https://collabs.shop/xvwqlb', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000031';
UPDATE products SET affiliate_url = 'https://collabs.shop/h69eau', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000032';
UPDATE products SET affiliate_url = 'https://collabs.shop/jaobuw', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000033';
UPDATE products SET affiliate_url = 'https://collabs.shop/yxvlz9', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000034';
UPDATE products SET affiliate_url = 'https://collabs.shop/3wqcvh', updated_at = now() WHERE id = 'd0c70000-0000-4000-8000-000000000035';

COMMIT;
