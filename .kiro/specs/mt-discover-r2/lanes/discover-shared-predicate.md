---
lane: discover-shared-predicate
state: ready
next_actor: kiro
depends_on: [supplier-relationships-db]
executor: kiro
seat: jtadic
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
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
updated: 2026-11-01T15:57Z
repos: [exafyltd/vitana-platform]
---
# discover-shared-predicate — one shared Discover predicate + inventory + lineage guard (VTID allocated by PLAN-SPAR, repo vitana-platform)

Plan: `.kiro/specs/mt-discover-r2/plan.md` (authoritative) and the `discover-shared-predicate` group in `tasks.md`
(tasks P1–P6, allowed paths, acceptance). Design + successor rules: `design.md`.

The VTID comes from PLAN-SPAR on convergence, never by hand.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. Work only inside the allowed paths. Dark by default
(`MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.discover_tenant_gate` / `mt.network_enabled`) — no behaviour
change while the flags are off, so Maxina Discover is unchanged (D7). This lane adds its own `docs/validation/<vtid>/`.
Branch `kiro/mt-discover-r2/discover-shared-predicate`; PR title
`VTID-xxxxx (mt-discover-r2/discover-shared-predicate): …`; commit trailers `Collab-Session: <your kiro session id>` and
`Collab-Lane: mt-discover-r2/discover-shared-predicate`. When the PR is open: set `state: in-review`, `next_actor: kiro`
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
### 2026-11-01T15:57Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-discover/discover-shared-predicate`. Versions day-shifted to `20261102120*`. Reviewer agent.
