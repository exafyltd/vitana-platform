# VTID-03237 — Acceptance (Video Shop gateway slice)

Scope of THIS PR: gateway-only (`services/gateway/src/**`). The schema migration,
`DATABASE_SCHEMA.md`, and the drawer spec ship in the paired data PR (#2487).

Verification tokens: TEST = jest suite, CURL = HTTP contract (run against a deploy
with the data PR applied). The validator requires each AC to map to a token; the
runtime CURLs are gated on the data PR being merged first.

AC-1 — Shop-feed routes are community-role-gated (401 unauthenticated, 403 non-community)
  TEST: services/gateway/test/universal-cart.test.ts (shared getUserContext / getActiveRole gate)
  CURL: GET /api/v1/shop-feed/videos with no Bearer -> 401 UNAUTHENTICATED
  CURL: GET /api/v1/shop-feed/videos as admin role -> 403 shop_unavailable_for_role

AC-2 — Feed returns only live videos that have a purchasable primary anchor
  CURL: GET /api/v1/shop-feed/videos -> 200 { ok:true, videos:[...], next_cursor }
  CURL: videos[].primary_anchor.product.in_stock is always true (OOS anchors dropped)

AC-3 — Drawer anchor payload reflects the LIVE product (price/stock re-read at request time)
  CURL: GET /api/v1/shop-feed/videos/:id/anchor -> 200 { ok, anchor.product } or 404 anchor_unavailable

AC-4 — Funnel events ingest into the non-OASIS sink (shop_video_events), never oasis_events
  CURL: POST /api/v1/shop-feed/videos/:id/events { type:"impression", session_id } -> 202
  CURL: POST /api/v1/shop-feed/events/batch { events:[...] } -> 202 { accepted:N }

AC-5 — Saves are owner-scoped and idempotent on (user, product)
  CURL: POST /api/v1/shop-feed/saved { product_id } -> 201; repeat -> 201 (no duplicate)
  CURL: DELETE /api/v1/shop-feed/saved/:productId -> 204

AC-6 — Universal Cart accepts video_shop + attribution and validates the anchored product
  TEST: services/gateway/test/universal-cart.test.ts (38 passing)
  CURL: POST /api/v1/universal-cart/items { source_surface:"video_shop", product_id, source_video_id } -> 201 when active+in_stock+anchored; 409 product_unavailable / product_out_of_stock / product_not_anchored_to_video otherwise

AC-7 — Gateway typecheck, full test suite, and build are green
  TEST: npm run typecheck (0 errors) && npm test (286 suites / 4939 passing) && npm run build (exit 0)
  See ./commands.log and ./outputs/ for captured results.
