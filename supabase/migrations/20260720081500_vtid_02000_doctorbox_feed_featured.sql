-- VTID-02000 (Discover marketplace) — feature DoctorBox flagships in early feeds.
--
-- The category_mix fix (20260717121500_..._doctorbox_feed_category_mix.sql)
-- wasn't enough on its own: feed-ranker.ts weights rating (ratingScoreMax=0.3)
-- and featured_product_ids (featuredBoost=0.7) far more heavily than
-- category_mix (categoryMixWeight=0.2, applied to a 0-1 mix value — max
-- realistic contribution ~0.04). DoctorBox products have rating=NULL (no
-- fabricated stars/review counts — see the seed migration's own comment),
-- so they score near the bottom of the default, un-personalized feed and
-- never clear the top-N cutoff, even with a category_mix entry — confirmed
-- via GET /api/v1/discover/feed returning 0 DoctorBox items after the
-- category_mix fix alone.
--
-- Rather than fabricate ratings to game the ranker, use the mechanism this
-- code already has for exactly this situation: featured_product_ids
-- ("Featured by editors" boost, +0.7 — decisively larger than any rating
-- could contribute). This is an honest editorial pin, not invented customer
-- sentiment. Confirmed via query: no default_feed_config row currently uses
-- featured_product_ids at all (Bodylab24 surfaces purely on its own seeded
-- ratings, which is a different, already-existing case, not touched here).
--
-- Featured: one representative DoctorBox product per subcategory (9 total),
-- scoped to onboarding + early lifecycle stages (matching where
-- max_products_per_merchant=12 already applies) across all region_group
-- rows. Established/mature stages are intentionally left alone — those are
-- meant to converge toward already-proven performers, not editorial picks.
-- Not an attempt to force all 53 products into the feed — same per-merchant
-- cap (12) applies to DoctorBox as every other merchant; this just makes it
-- competitive enough to win its fair share of slots.
--
-- impact-allow-solo-migration: intentional data-only config tune, fully
-- consumed by existing feed-ranker.ts.

BEGIN;

UPDATE default_feed_config
SET featured_product_ids = (
      SELECT array_agg(DISTINCT x)
      FROM unnest(
        COALESCE(featured_product_ids, ARRAY[]::uuid[]) || ARRAY[
          'd0c70000-0000-4000-8000-000000000004'::uuid, -- Vitamin D Test (nutrients-vitamins)
          'd0c70000-0000-4000-8000-00000000000c'::uuid, -- Schilddrüsen Check Plus (hormones)
          'd0c70000-0000-4000-8000-000000000011'::uuid, -- Herz-Kreislauf Check (cardio)
          'd0c70000-0000-4000-8000-000000000017'::uuid, -- Bio Age - Dein biologisches Alter (longevity-fitness)
          'd0c70000-0000-4000-8000-000000000013'::uuid, -- Rundum Check für Frauen (womens-health)
          'd0c70000-0000-4000-8000-000000000023'::uuid, -- STI Basic (sexual-health)
          'd0c70000-0000-4000-8000-000000000026'::uuid, -- Darmkrebsvorsorge (prevention)
          'd0c70000-0000-4000-8000-00000000002c'::uuid, -- Allergietest (295 Allergene) (general-health)
          'd0c70000-0000-4000-8000-000000000034'::uuid  -- COFFEEGEN (dna-analysis)
        ]
      ) AS x
    ),
    updated_at = now()
WHERE lifecycle_stage IN ('onboarding', 'early');

COMMIT;

-- =====================================================================================
-- DOWN (rollback):
-- BEGIN;
-- UPDATE default_feed_config
-- SET featured_product_ids = (
--   SELECT array_agg(x) FROM unnest(featured_product_ids) x
--   WHERE x NOT IN (
--     'd0c70000-0000-4000-8000-000000000004','d0c70000-0000-4000-8000-00000000000c',
--     'd0c70000-0000-4000-8000-000000000011','d0c70000-0000-4000-8000-000000000017',
--     'd0c70000-0000-4000-8000-000000000013','d0c70000-0000-4000-8000-000000000023',
--     'd0c70000-0000-4000-8000-000000000026','d0c70000-0000-4000-8000-00000000002c',
--     'd0c70000-0000-4000-8000-000000000034'
--   )
-- ), updated_at = now()
-- WHERE lifecycle_stage IN ('onboarding','early');
-- COMMIT;
-- =====================================================================================
