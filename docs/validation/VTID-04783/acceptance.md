# VTID-04783 — Commerce products land in the matching Discover category (step B1)

Owner request, 2026-10-01: everyone who registers through Commerce shows up in
the part of Discover that applies to them. Step A (VTID-04769) made products
appear on go-live; this step makes them appear in the right category. Owner
approved the vertical → category mapping and asked that it scale: "there will
be even more categories by time" — so categories are data, not code.

## Acceptance criteria

AC-1 — Discover categories and subcategories are data (`discover_categories`, `discover_subcategories`); the three existing categories keep their keys and i18n keys.
TEST: services/gateway/test/vtid-04783-discover-categories-migration.test.ts + docs/validation/VTID-04783/migration-scenarios.sql

AC-2 — Every supplier vertical maps to its Discover category as data (`catalog_verticals.discover_category`), per the owner-approved table; services has none until step C.
TEST: services/gateway/test/vtid-04783-discover-categories-migration.test.ts (scenarios "beauty_care -> skincare", "diagnostics -> health-tests", "services vertical: no Discover category")

AC-3 — A supplier product lands in its Discover category whatever path wrote it (form, API, CSV), including a CSV row with no category; network products are never touched.
TEST: docs/validation/VTID-04783/migration-scenarios.sql (scenarios "network product untouched", "owner-keyed fitness merchant -> fitness", "unknown free text falls back to the merchant vertical")

AC-4 — A subcategory is kept only when it belongs to the product's category; an unknown one is cleared and never hides the product.
TEST: docs/validation/VTID-04783/migration-scenarios.sql (scenarios "subcategory of another category dropped", "Discover category kept, subcategory trimmed and lower-cased")

AC-5 — A new category added as data only (rows + a vertical mapping) works with no code change.
TEST: docs/validation/VTID-04783/migration-scenarios.sql (scenario "a category added as data works with no code change")

AC-6 — `GET /api/v1/discover/categories` returns the category tree with live counts and i18n label keys; only categories with live products unless `include_empty=true`; products without a known subcategory are counted as unsorted, never lost.
TEST: services/gateway/test/services/discover-categories.test.ts

AC-7 — The supplier portal can set a subcategory: product API, CSV `subcategory` column, and the vertical list carries each vertical's subcategories.
TEST: services/gateway/test/routes/vcaop-portal-my-products.test.ts + services/gateway/test/services/partner-catalogue-csv.test.ts

## Route

ROUTE_MOUNT: `router.get('/categories', …)` added to `services/gateway/src/routes/discover-search.ts`, which `src/index.ts` already mounts at `/api/v1/discover` (`mountRouterSync`, owner `discover-search`). No change to `index.ts`.
FINAL_URL: `GET /api/v1/discover/categories` (staging: https://preview-aws-gateway.vitanaland.com/api/v1/discover/categories)
CURL_PROOF: public, read-only GET — the first two checks in `staging-tests.json` (200 application/json with `discover.categoryNames.` label keys; `include_empty=true` lists `fitness`). Requires the migration applied first (the route reads the new tables).

## Evidence

- `migration-scenarios.sql` — 15 scenarios on a throwaway local PostgreSQL 16,
  migration applied twice: `outputs/migration-scenarios-postgres16.txt`, all ok.
- Jest suites above (CI Gateway Jest; npm registry is blocked in this sandbox).

## Order of release

The migration must be applied **before** this merges: staging and production
gateways share the production database, and the new route reads the new
tables. Applying it first is safe on its own: the trigger touches only
supplier products (0 exist today), and the counts function and tables are new.

## Not in this step

- B2 (vitana-v1): Discover renders its category list from this endpoint, a
  "More in …" group for unsorted products, the subcategory picker in the
  product form and CSV template, and labels for the new categories.
- C: business profiles and a home for services/practitioners.
