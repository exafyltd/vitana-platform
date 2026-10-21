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

# ---------------------------------------------------------------------------
# V1.2 — Checkout bridge (POST /api/v1/universal-cart/checkout)
# ---------------------------------------------------------------------------

ROUTE_MOUNT: services/gateway/src/routes/universal-cart.ts → router.post('/checkout'); mounted in src/index.ts at /api/v1/universal-cart
FINAL_URL: POST {gateway}/api/v1/universal-cart/checkout
CURL_PROOF: curl -sS -X POST "$GATEWAY/api/v1/universal-cart/checkout" -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d '{"idempotency_key":"<uuid>"}'

AC-8 — Checkout routes each cart line by product source (hybrid)
  TEST: services/gateway/test/checkout-service.test.ts (11 passing)
  RULE: products.source_network ∈ {manual,partner} → first-party (wallet); else affiliate (click-out)
  CURL: first-party line → wallet_order:{currency,amount_minor,balance_minor,order_ids[]}; affiliate line → affiliate_redirects:[{product_id,affiliate_url,order_id}]

AC-9 — First-party checkout debits the wallet exactly once and is idempotent
  TEST: debit_wallet_for_spend called with reference_type='cart_checkout', reference_id=checkout_id; duplicate=true on replay
  CURL: re-POST with the same idempotency_key → same checkout_id, no second debit, no duplicate orders

AC-10 — Money-safety: pending orders precede the debit; failure never leaves money-without-record
  TEST: INSUFFICIENT_BALANCE → 402, zero cart items completed; PRODUCT_UNAVAILABLE/out_of_stock → 409 before any debit or order write
  CURL: insufficient balance → 402 { error:"INSUFFICIENT_BALANCE", balance_minor, required_minor }

AC-11 — Purchase funnel events land in shop_video_events (non-OASIS), never oasis_events
  TEST: settled first-party video lines emit event_type='purchase'; affiliate video lines emit 'checkout_start'
