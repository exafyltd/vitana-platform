-- VTID-02000 (Discover marketplace) — Bodylab24 real per-product deeplinks +
-- admitad_feed junk cleanup.
--
-- Context: the 4 hand-seeded Bodylab24 products all pointed their
-- affiliate_url at the bare bodylab24.de homepage (not a specific product).
-- Bodylab24 does not offer a bulk Admitad Product Feed (verified in the
-- publisher dashboard — Program search returns no results), only the
-- single-link "Get link" deeplink tool, so these were hand-built there
-- against the real matching product page for each seeded item.
--
-- Also deactivates the 200 'admitad_feed' rows imported by an earlier
-- keyword-filter bug in admitad-sync.ts (bare terms like "zinc" and
-- "protein powder" matched unrelated kitchenware/tool/toy listings — see
-- the fix in that file). None of these rows were category='supplements' so
-- they never surfaced on Discover, but they're garbage and should not
-- linger as is_active=true.
--
-- impact-allow-solo-migration: data-only migration, no code path changes
-- required — /r/:product_id already 302s any non-demo_seed product to its
-- affiliate_url, and discover-search/feed already filter on is_active.

BEGIN;

UPDATE products SET
  affiliate_url = 'https://ad.admitad.com/g/q51r4zfcu52fafe74eabfad1369401/?ulp=https%3A%2F%2Fwww.bodylab24.de%2Fomega-3-1000mg-tg-120-kapseln.html',
  updated_at = now()
WHERE id = 'd15c0000-0000-4000-8000-000000000009';

UPDATE products SET
  title = 'Magnesium Bisglycinate 300mg — Muscle & Sleep',
  description = 'Bodylab24 Magnesium Bisglycinate, 300mg elemental magnesium per daily dose (2 capsules) — supports muscle function, recovery and restful sleep.',
  description_long = 'Magnesium contributes to normal muscle function and a reduction in tiredness. Bisglycinate is bound to an amino acid for excellent tolerability and bioavailability. A staple for active people and anyone with poor sleep. Take in the evening.',
  affiliate_url = 'https://ad.admitad.com/g/q51r4zfcu52fafe74eabfad1369401/?ulp=https%3A%2F%2Fwww.bodylab24.de%2Fmagnesium-bisglycinate-120-kapseln.html',
  updated_at = now()
WHERE id = 'd15c0000-0000-4000-8000-00000000000a';

UPDATE products SET
  affiliate_url = 'https://ad.admitad.com/g/q51r4zfcu52fafe74eabfad1369401/?ulp=https%3A%2F%2Fwww.bodylab24.de%2Fproducts%2Fvitamin-d3-k2-oel-tropfen-50ml',
  updated_at = now()
WHERE id = 'd15c0000-0000-4000-8000-00000000000b';

UPDATE products SET
  affiliate_url = 'https://ad.admitad.com/g/q51r4zfcu52fafe74eabfad1369401/?ulp=https%3A%2F%2Fwww.bodylab24.de%2Fproducts%2Fvitamin-b-complex-120-tabletten',
  updated_at = now()
WHERE id = 'd15c0000-0000-4000-8000-00000000000c';

-- Retire the junk rows from the buggy admitad_feed sync run (all 200 were
-- false-positive matches — kitchenware, power-tool parts, toy figures, etc.)
UPDATE products SET is_active = false, updated_at = now()
WHERE source_network = 'admitad_feed';

COMMIT;

-- =====================================================================================
-- DOWN (rollback) — run manually or as a reverting migration if needed:
--
-- BEGIN;
-- UPDATE products SET
--   affiliate_url = 'https://ad.admitad.com/g/q51r4zfcu52fafe74eabfad1369401/?subid=discover&ulp=https%3A%2F%2Fwww.bodylab24.de%2F',
--   updated_at = now()
-- WHERE id IN (
--   'd15c0000-0000-4000-8000-000000000009', 'd15c0000-0000-4000-8000-00000000000a',
--   'd15c0000-0000-4000-8000-00000000000b', 'd15c0000-0000-4000-8000-00000000000c');
-- UPDATE products SET
--   title = 'Magnesium Capsules 400mg — Muscle & Sleep',
--   description = 'Bodylab24 magnesium, 400mg elemental per serving — supports muscle function, recovery and restful sleep.',
--   description_long = 'Magnesium contributes to normal muscle function and a reduction in tiredness. A staple for active people and anyone with poor sleep. Take in the evening.'
-- WHERE id = 'd15c0000-0000-4000-8000-00000000000a';
-- -- (admitad_feed junk rows are not worth restoring; leave is_active=false)
-- COMMIT;
-- =====================================================================================
