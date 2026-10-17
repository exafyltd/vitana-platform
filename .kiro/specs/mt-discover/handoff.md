---
slug: mt-discover
author: kiro
author_seat: hotmail
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-10-17T13:44Z
---
# Handoff — mt-discover (Commerce & Discover × tenancy, WS11 + Discover scope of §4.11)

Planner: Kiro seat `hotmail` (session `kiro-hotmail-202610151618-b437`). Program plan: `docs/MULTI-TENANT-PLAN.md`
§4.9/§4.10/§4.11, §6 WS11. Plan: `plan.md` (between the plan markers). Requirements, design, tasks, lanes alongside.
Drafted — sparred by PLAN-SPAR; VTIDs allocated on convergence; lanes then flip from `owner`/`claude`-held to `kiro`.

Lanes:
- `supplier-relationships-db` — repo vitana-platform, executor **kiro** (seat `hotmail`, reviewer `jtadic`),
  DB: `supplier_tenant_relationships`, `products.distribution`, `partner_tenant.tenant_id` backfill, referral
  attribution. HELD at `next_actor: owner` until PLAN-SPAR allocates the VTID.
- `discover-shared-predicate` — repo vitana-platform, executor **kiro** (seat `jtadic`, reviewer `hotmail`),
  the one shared Discover predicate + generated reader inventory + lineage guard. Depends on
  `supplier-relationships-db`. HELD at `next_actor: owner`.
- `supplier-onboarding-communities` — repo vitana-platform, executor **kiro** (seat `jtadic`, reviewer `exafy`),
  "which communities" + platform/commerce signup path + referral attribution. Depends on `supplier-relationships-db`.
  HELD at `next_actor: owner`.
- `discover-mode-ui` — repo vitana-v1, executor **kiro** (seat `exafyltd`, reviewer `jtadic`), the separate
  Discover Community/Network control + supplier UI. Depends on `discover-shared-predicate`. HELD at `next_actor: owner`.

Cross-spec (CROSS-SPEC-DECISIONS applied): O5 — mt-discover references mt-community-isolation M2's
`platform_only_accounts` view, does NOT create it, and carries no stale Risks line about it (none present). Network
groups and messenger scope stay in mt-network; this spec owns only Discover + offering distribution.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → drafted
Drafted the mt-discover spec (WS11 + Discover part of §4.11). Verified premises against platform origin/main
2026-10-15: `supplier_tenant_relationships` absent (0 matches in migrations + gateway src); every `products`/
`merchants` reader global (`is_active`/`availability` only) at the file:line set in plan.md Problem 2;
`tenant_catalog_overrides` exists but unenforced; `products.distribution` absent; `partner_tenant.tenant_id =
caller.tenantId || 'platform'` at `partner-onboarding-service.ts:948`; Discover scope control must be separate from
the tab pill and `MobileModePill` (SPOTLIGHT_RULES.md §D). Four lanes: one DB (hotmail), two gateway (jtadic), one
frontend (exafyltd), DB split from code per §4.7. queue.mjs validators pass on handoff.md and all lanes (0 errors).
Next: PLAN-SPAR spars the plan PR; on convergence it allocates the VTIDs and flips the lanes to `kiro`.

### 2026-10-15T17:05Z · kiro-hotmail-202610151618-b437 · internal review fixes (drafted)
Resolved both internal-review MEDIUM findings, each premise re-verified against current code:
(1) **Reader classes.** Split the generated Discover inventory into `discovery` readers (open feed/search/browse,
full predicate) and `fulfilment` readers (by explicit product id, unfiltered + annotated `// discover-inventory:
fulfilment`). Confirmed the three by-id lookups in code: `shop-feed-repository.ts:32`,
`cart-checkout-tools-repository.ts:36`, `checkout-service-repository.ts:42` (all `fetchProductsByIds`). Gating them
would 404 a saved/in-flight order mid-checkout. Updated plan Fix + Problem 2, design (discover-shared-predicate +
Rule 3), requirements R1/R3, tasks P2/P3, and the isolation suite (plan Tests). (2) **Attribution table named.**
The migration ALTERs `product_orders` (`buyer_tenant_id uuid`, nullable, expand-only, no default) — verified as the
commission-attribution row at `credit-recommender-repository.ts:28 fetchProductOrderForCommission`;
`recommendation_commissions` already carries `recommender_user_id`, so no column there. Added dark, read only by
`supplier-onboarding-communities` S4 (already `depends_on supplier-relationships-db`). Updated plan Fix + Migrations,
design, tasks D4. Plan body 13.7k chars (<= 15k). queue.mjs validators re-run on handoff.md + all 4 lanes: 0 errors.
Open HIGH/MEDIUM after this pass: 0.

### 2026-10-17T13:44Z · kiro-hotmail-202610151618-b437 · internal review fixes (drafted)
Resolved the second internal-review pass: 1 HIGH + 2 MEDIUM (INTERNAL-REVIEW.json verdict REJECTED). Each premise
re-verified against current code (file:line):
(1) **HIGH — lineage-guard granularity.** The guard is now specified PER-QUERY, not per-module: it fails only when
the SAME query that reads `products`/`merchants` also touches a health_*/wearable_*/biomarker_*/lab_*/vitana_index_*
table, and must NOT flag a sibling function in the same file. Verified the two mixed-module files that a per-module
guard would RED-flag: `health-wellness-repository.ts` (products `:91`; health `:28,:32,:44,:50,:55,:68`) and
`health-action-initiative-repository.ts` (products `:81`; health `:26,:30,:54,:60,:64`). Named both as the files the
guard must tolerate. Updated plan Problem 10 + Fix + Risks, requirements R4, design Rule 4 + predicate section, tasks
P3/P5, lane `discover-shared-predicate` body.
(2) **MEDIUM — wrong discovery reader.** `shop-feed-repository.ts:43 fetchRankedShopVideosPage` reads `shop_videos`,
NOT `products`/`merchants` (verified: select carries no product id), so it is not a predicate reader at all. Removed
from the discovery list everywhere; stated `shop_videos` scoping is a separate concern, out of scope. Updated plan
Problem 2 + Fix, design (readers list + predicate + removed from discovery), requirements R3, tasks P2.
(3) **MEDIUM — by-id classification rule.** Added the explicit discovery-vs-fulfilment rule: a by-id lookup that
INITIATES a new discovery action is DISCOVERY (gated) — so `discover-recommendations-repository.ts:23`
(`fetchActiveProductForRecommendation`) is DISCOVERY; a by-id lookup that HYDRATES an already-held item is FULFILMENT
(unfiltered) — so `fetchProductsByIds` (shop-feed:32/cart-checkout:36/checkout:42) and
`health-action-initiative-repository.ts:81 fetchProductById` are FULFILMENT. Updated plan Problem 2 + Fix,
requirements R1/R3, design, tasks P2.
Plan body ~15.3k chars (within ~15k soft bound). queue.mjs validators re-run on handoff.md + all 4 lanes: 0 errors.
Open HIGH/MEDIUM after this pass: 0.
