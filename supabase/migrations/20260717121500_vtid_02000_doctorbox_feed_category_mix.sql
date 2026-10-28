-- VTID-02000 (Discover marketplace) — surface DoctorBox in the default feed ranking.
--
-- Root cause: default_feed_config.category_mix (feed-ranker.ts scoring input)
-- only lists 'books','devices','skincare','supplements','wellness-services'.
-- DoctorBox's category ('health-tests', from the seed migration
-- 20260717120000_..._discover_doctorbox_seed.sql) has no entry, so it scores
-- near-zero in default ranking and gets squeezed out of the top-N feed even
-- though the products are valid, active, in-stock candidates (confirmed via
-- GET /api/v1/discover/feed?category=health-tests, which returns them fine —
-- this is a ranking gap, not a query/eligibility bug).
--
-- Fix: add 'health-tests' to category_mix on every row, purely additive (no
-- reduction to existing categories' weights, so no regression to other
-- merchants' current visibility). Mirrors the precedent set by the original
-- Admitad catalog migration, which raised max_products_per_merchant from 3 to
-- 12 for the same reason — a newly-seeded catalog segment needs a feed-config
-- tune to actually surface, not just exist.
--
-- impact-allow-solo-migration: intentional data-only config tune, fully
-- consumed by existing feed-ranker.ts / discover-feed.ts code.

BEGIN;

UPDATE default_feed_config
SET category_mix = category_mix || '{"health-tests": 0.2}'::jsonb,
    updated_at = now()
WHERE NOT (category_mix ? 'health-tests');

COMMIT;

-- =====================================================================================
-- DOWN (rollback):
-- BEGIN;
-- UPDATE default_feed_config SET category_mix = category_mix - 'health-tests', updated_at = now();
-- COMMIT;
-- =====================================================================================
