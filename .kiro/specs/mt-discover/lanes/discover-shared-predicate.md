---
lane: discover-shared-predicate
state: ready
next_actor: owner
depends_on: [supplier-relationships-db]
executor: kiro
seat: jtadic
reviewer_seat: hotmail
paths:
  - services/gateway/src/services/discover/**
  - services/gateway/src/routes/discover-feed-repository.ts
  - services/gateway/src/routes/discover-search-repository.ts
  - services/gateway/src/routes/discover-recommendations-repository.ts
  - services/gateway/src/routes/shop-feed-repository.ts
  - services/gateway/src/routes/universal-cart-context-repository.ts
  - services/gateway/src/routes/click-redirect-repository.ts
  - services/gateway/src/routes/admin-marketplace-repository.ts
  - services/gateway/src/routes/catalog-ingest-repository.ts
  - services/gateway/src/routes/vcaop-portal-my-products.ts
  - services/gateway/src/routes/partner-onboarding-catalogue.ts
  - services/gateway/src/routes/partner-onboarding.ts
  - services/gateway/src/services/orb-tools/marketplace-discovery-tools.ts
  - services/gateway/src/services/orb-tools/marketplace-*-repository.ts
  - services/gateway/src/services/orb-tools/cart-checkout-tools-repository.ts
  - services/gateway/src/services/automation-handlers/health-wellness-repository.ts
  - services/gateway/src/services/automation-handlers/health-action-initiative-repository.ts
  - services/gateway/src/services/checkout/checkout-service-repository.ts
  - services/gateway/src/services/gemini-operator-repository.ts
  - services/gateway/src/services/intent-matcher-repository.ts
  - services/gateway/src/services/partner-onboarding-service.ts
  - services/gateway/src/services/partner-review.ts
  - services/gateway/src/services/partner-setup.ts
  - services/gateway/src/services/shopify-sync-repository.ts
  - services/gateway/src/services/marketplace-sync/shared-repository.ts
  - services/gateway/src/services/marketplace-sync/amazon-sync-repository.ts
  - services/gateway/src/services/admin-scanners/marketplace-repository.ts
  - services/gateway/src/services/recommendation-engine/analyzers/marketplace-analyzer-repository.ts
  - services/gateway/src/services/recommendation-commissions/credit-recommender-repository.ts
  - services/gateway/src/services/shopping-agent/agent-core-repository.ts
  - services/gateway/src/services/shopping-agent/reorder-core-repository.ts
  - scripts/ci/discover-reader-inventory.mjs
  - services/gateway/test/vtid-*-discover-tenant-visibility.test.ts
  - services/gateway/test/vtid-*-discover-lineage-guard.test.ts
  - services/gateway/test/vtid-*-discover-isolation.test.ts
updated: 2026-10-17T15:10Z
---
# discover-shared-predicate — one shared Discover predicate + inventory + lineage guard (VTID allocated by PLAN-SPAR, repo vitana-platform)

Plan: `.kiro/specs/mt-discover/plan.md` (authoritative) and the `discover-shared-predicate` group in `tasks.md`
(tasks P1–P6, allowed paths, acceptance). Design + successor rules: `design.md`.

**HELD:** `next_actor: owner` until PLAN-SPAR allocates this lane's VTID — PLAN-SPAR flips it to `kiro`. Depends on
`supplier-relationships-db` (reads `supplier_tenant_relationships` + `products.distribution`): do not start before it
is done.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. Work only inside the allowed paths. Dark by default
(`MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.discover_tenant_gate` / `mt.network_enabled`) — no behaviour
change while the flags are off, so Maxina Discover is unchanged (D7). This lane adds its own `docs/validation/<vtid>/`.
Branch `kiro/mt-discover/discover-shared-predicate`; PR title
`VTID-xxxxx (mt-discover/discover-shared-predicate): …`; commit trailers `Collab-Session: <your kiro session id>` and
`Collab-Lane: mt-discover/discover-shared-predicate`. When the PR is open: set `state: in-review`, `next_actor: kiro`
(reviewer seat `hotmail`), `pr: <url>`, append a log entry, release the claim.

The reader inventory is GENERATED, not hand-listed; the lint and the lineage guard are build-failing. **This lane
owns the FULL set of `products`/`merchants` readers in `services/gateway/src`** — a fresh sweep (2026-10-17) found
every file in `paths` above, so the lane can annotate/route each one and the PR-GATE Lane-scope check passes. The
lint has THREE sanctioned dispositions, anything else fails: **discovery** (open feed/search/browse, or a by-id
lookup that INITIATES discovery → full predicate), **fulfilment** (by-explicit-id hydration of an already-held item →
unfiltered, `// discover-inventory: fulfilment`), and **admin/ingestion** (admin/back-office/supplier-portal and
catalog-ingestion reads+writes, served to an admin/supplier surface not a member Discover/ORB surface → unfiltered,
admin-guarded, `// discover-inventory: admin`). The lineage guard is PER-QUERY (fails only when the same query that
reads `products`/`merchants` also reads a health table), and must tolerate the mixed files
`health-wellness-repository.ts` / `health-action-initiative-repository.ts` whose health reads are in sibling
functions. `shop-feed-repository.ts:43 fetchRankedShopVideosPage` reads `shop_videos` and is NOT in scope.
`fetchProductsByIds` (`shop-feed-repository.ts:32`) is DUAL-USE (R1-F1): split the video-anchor call site (DISCOVERY,
predicate-gated) from the saved-products call site (FULFILMENT, unfiltered) — the lint classifies by call site, not
whole-function. If the ORB product/cart tool dispatch is changed, add the Nova + Vertex Serbian bridge dispatcher
tests (42h).

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created, HELD at `next_actor: owner`. Gateway code lane (seat `jtadic`). The one shared Discover predicate
(`services/gateway/src/services/discover/tenant-visibility.ts`), the generated reader inventory + lint, the lineage
guard, and the Discover isolation suite. Depends on `supplier-relationships-db`.

### 2026-10-17T15:10Z · kiro-hotmail-202610151618-b437 · internal review fixes (ready)
HIGH-1 + MEDIUM-1 (INTERNAL-REVIEW REJECTED). A full `from('products')|from('merchants')` sweep of
`services/gateway/src` (2026-10-17) replaced the hand-list: added every missing reader file to `paths` and the
tasks `Allowed paths` block so the generated build-failing lint can annotate/route each one without the PR leaving
its paths (Lane scope). Added the third sanctioned disposition **admin/ingestion** (`// discover-inventory: admin`)
for admin/back-office/supplier-portal + catalog-ingestion readers. Full swept list in handoff.md log.

### 2026-10-15T16:50Z · kiro-hotmail-202610151618-b437 · replan refinement (ready)
`credit-recommender-repository.ts:114 fetchMerchantCommissionEligibility` reclassified from ADMIN/INGESTION to
FULFILMENT (verified lines 110–117: a by-explicit-`merchant_id` commission-eligibility read on an already-placed
order, no admin/member surface). Lane paths unchanged (the file is already in `paths`); the lint annotation for that
reader becomes `// discover-inventory: fulfilment`. Plan Problem 2 + tasks P2 updated.

### 2026-10-15T17:05Z · kiro-hotmail-202610151618-b437 · sparring round-1 fix R1-F1 (ready)
`fetchProductsByIds` (`shop-feed-repository.ts:32`) is dual-use (module comment at :31: reused for anchor-hydration
AND saved-products hydration). A single fulfilment stamp left the video-anchor path (a discovery surface)
tenant-ungated — a supplier active only in T_A could surface to T_B via a shop-video anchor. Fix: split the two call
sites, route the anchor path through the predicate (DISCOVERY), keep saved-products FULFILMENT. P2/P5 + plan Problem
2/Fix/Tests + the isolation suite updated to assert the anchor path is gated.

### 2026-10-21T14:25Z · kiro-hotmail-202610151618-b437 · spar session 2 round 2 — no path change
R3-F1: `fetchActiveProductsByTopicKeys` (`health-wellness-repository.ts:90-92`) is discovery and takes `ctx.tenantId`.
R3-F3: by-id initiator cited at `routes/discover-recommendations-repository.ts:22-23`. Both files were already in `paths`.
