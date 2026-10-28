-- VTID-02000 (Discover marketplace) — Bodylab24 Buy links now deep-link to the
-- product, not the bare homepage.
--
-- The initial catalog migration set the Bodylab24 products' Admitad `ulp` to the
-- bodylab24.de homepage (the per-product URL scheme wasn't verified). Users
-- reported the desktop "Buy" button landing on the homepage instead of the
-- product. This repoints each Bodylab24 product's affiliate deeplink at the
-- store's search-results page for that product — parity with the AliExpress
-- items (which already use search URLs). Still routed through the LIVE
-- admitad_bodylab24_de gotolink, so attribution/cashback are unchanged.
--
-- Data-only; consumed by the existing /r/:product_id redirect. No code change.
-- impact-allow-solo-migration: pure data update of affiliate_url on existing rows.

BEGIN;

UPDATE products SET affiliate_url =
  'https://ad.admitad.com/g/q51r4zfcu52fafe74eabfad1369401/?subid=discover&ulp=https%3A%2F%2Fwww.bodylab24.de%2Fsearch%3Fsearch%3Domega%2B3',
  updated_at = now()
WHERE source_network='admitad' AND source_product_id='bodylab24-omega-3-1000';

UPDATE products SET affiliate_url =
  'https://ad.admitad.com/g/q51r4zfcu52fafe74eabfad1369401/?subid=discover&ulp=https%3A%2F%2Fwww.bodylab24.de%2Fsearch%3Fsearch%3Dmagnesium',
  updated_at = now()
WHERE source_network='admitad' AND source_product_id='bodylab24-magnesium-400';

UPDATE products SET affiliate_url =
  'https://ad.admitad.com/g/q51r4zfcu52fafe74eabfad1369401/?subid=discover&ulp=https%3A%2F%2Fwww.bodylab24.de%2Fsearch%3Fsearch%3Dvitamin%2Bd3%2Bk2',
  updated_at = now()
WHERE source_network='admitad' AND source_product_id='bodylab24-vitamin-d3-k2';

UPDATE products SET affiliate_url =
  'https://ad.admitad.com/g/q51r4zfcu52fafe74eabfad1369401/?subid=discover&ulp=https%3A%2F%2Fwww.bodylab24.de%2Fsearch%3Fsearch%3Dvitamin%2Bb%2Bkomplex',
  updated_at = now()
WHERE source_network='admitad' AND source_product_id='bodylab24-b-complex';

COMMIT;

-- DOWN (rollback) — repoint to the homepage:
-- UPDATE products SET affiliate_url =
--   'https://ad.admitad.com/g/q51r4zfcu52fafe74eabfad1369401/?subid=discover&ulp=https%3A%2F%2Fwww.bodylab24.de%2F'
-- WHERE source_network='admitad' AND source_product_id LIKE 'bodylab24-%';
