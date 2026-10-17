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
  - services/gateway/src/services/orb-tools/marketplace-discovery-tools.ts
  - services/gateway/src/services/orb-tools/marketplace-guide-tools-repository.ts
  - services/gateway/src/services/orb-tools/marketplace-journey-tools-repository.ts
  - services/gateway/src/services/orb-tools/cart-checkout-tools-repository.ts
  - services/gateway/src/services/automation-handlers/health-wellness-repository.ts
  - services/gateway/src/services/automation-handlers/health-action-initiative-repository.ts
  - services/gateway/src/services/checkout/checkout-service-repository.ts
  - scripts/ci/discover-reader-inventory.mjs
  - services/gateway/test/vtid-*-discover-tenant-visibility.test.ts
  - services/gateway/test/vtid-*-discover-lineage-guard.test.ts
  - services/gateway/test/vtid-*-discover-isolation.test.ts
updated: 2026-10-15T16:40Z
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

The reader inventory is GENERATED, not hand-listed; the lint and the lineage guard are build-failing. The lineage
guard is PER-QUERY (fails only when the same query that reads `products`/`merchants` also reads a health table), and
must tolerate the mixed files `health-wellness-repository.ts` / `health-action-initiative-repository.ts` whose health
reads are in sibling functions. `shop-feed-repository.ts:43 fetchRankedShopVideosPage` reads `shop_videos` and is NOT
in scope. If the ORB product/cart tool dispatch is changed, add the Nova + Vertex Serbian bridge dispatcher tests (42h).

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created, HELD at `next_actor: owner`. Gateway code lane (seat `jtadic`). The one shared Discover predicate
(`services/gateway/src/services/discover/tenant-visibility.ts`), the generated reader inventory + lint, the lineage
guard, and the Discover isolation suite. Depends on `supplier-relationships-db`.
