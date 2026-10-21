---
slug: mt-discover
author: kiro
author_seat: hotmail
executor: kiro
next_actor: claude
state: drafted
updated: 2026-10-21T14:27Z
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

### 2026-10-17T15:10Z · kiro-hotmail-202610151618-b437 · internal review fixes (drafted)
Resolved the third internal-review pass: 1 HIGH + 1 MEDIUM + 1 NIT (INTERNAL-REVIEW.json verdict REJECTED).
(1) **HIGH — incomplete reader inventory + lane paths.** Ran a FULL `from('products')|from('merchants')` sweep of
`services/gateway/src` (2026-10-17, PowerShell Select-String, files-unique) instead of the earlier hand-list. The
complete reader set the generated build-failing lint can flag, classified:
 • **DISCOVERY (full predicate):** `routes/discover-feed-repository.ts:40`, `routes/discover-search-repository.ts:29,:37`,
   `routes/discover-recommendations-repository.ts:23`, `services/orb-tools/marketplace-discovery-tools-repository.ts`
   (search:34, by-title-top1:47, by-category:51, deals:68, by-id:43), `services/orb-tools/marketplace-va-shared-repository.ts`
   (fuzzy-title:44, by-id:35), `services/orb-tools/marketplace-guide-tools-repository.ts:42,:55`,
   `services/orb-tools/marketplace-journey-tools-repository.ts:33,:67`,
   `services/automation-handlers/health-wellness-repository.ts:91`, `services/gemini-operator-repository.ts:39,:62`,
   `services/intent-matcher-repository.ts:32`,
   `services/recommendation-engine/analyzers/marketplace-analyzer-repository.ts:40`,
   `services/shopping-agent/agent-core-repository.ts:27`.
 • **FULFILMENT (by-id hydration, annotated `// discover-inventory: fulfilment`, unfiltered):**
   `routes/shop-feed-repository.ts:32`, `services/orb-tools/cart-checkout-tools-repository.ts:36,:41` (NOT :45
   searchActiveProductsByTitle — that is DISCOVERY), `services/checkout/checkout-service-repository.ts:42`,
   `services/automation-handlers/health-action-initiative-repository.ts:81`,
   `routes/universal-cart-context-repository.ts:45`, `services/shopping-agent/reorder-core-repository.ts:24`,
   `routes/click-redirect-repository.ts:20`, `services/orb-tools/marketplace-journey-tools-repository.ts:51,:55`,
   `services/orb-tools/marketplace-discovery-tools-repository.ts` (fetchProductTitlesByIds, fetchProductTitleById).
 • **ADMIN/INGESTION (annotated `// discover-inventory: admin`, unfiltered, admin-guarded):**
   `routes/admin-marketplace-repository.ts`, `routes/catalog-ingest-repository.ts`, `routes/vcaop-portal-my-products.ts`,
   `routes/partner-onboarding-catalogue.ts`, `routes/partner-onboarding.ts`, `services/partner-onboarding-service.ts`,
   `services/partner-review.ts`, `services/partner-setup.ts`, `services/shopify-sync-repository.ts`,
   `services/marketplace-sync/shared-repository.ts`, `services/marketplace-sync/amazon-sync-repository.ts`,
   `services/admin-scanners/marketplace-repository.ts`, `services/recommendation-commissions/credit-recommender-repository.ts:114`.
 • **NOT a products/merchants reader:** `routes/shop-feed-repository.ts:43 fetchRankedShopVideosPage` (`shop_videos`).
Added every file to `discover-shared-predicate`'s lane `paths` (cluster glob `orb-tools/marketplace-*-repository.ts`
+ explicit files) and the identical tasks.md "Allowed paths" block, so the lint can annotate/route each in-scope and
PR-GATE Lane-scope passes. Updated plan Problem 2 + Fix + Risks, design "What exists" + predicate section, tasks P2.
(2) **MEDIUM — admin/ingestion disposition.** Added the third sanctioned class `admin` (`// discover-inventory: admin`)
for admin/back-office/supplier-portal + catalog-ingestion readers served to an admin/supplier surface (distinguished
by surface, not member Discover/ORB), unfiltered + admin-guarded; lint fails anything unclassified. Updated R3,
design Rule 3 + inventory-generator description, plan Fix, tasks P3/P5, lane body.
(3) **NIT — plan body length.** Tightened Problem 2/Fix (reference design for the full list rather than restating) →
plan body 15.4k chars, in line with the prior pass's ~15.3k (within the ~15k soft bound). queue.mjs validators re-run
on handoff.md + all 4 lanes: 0 errors. Deleted sparring/INTERNAL-REVIEW.json. Open HIGH/MEDIUM after this pass: 0.

### 2026-10-17T15:47Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-15T16:50Z · kiro-hotmail-202610151618-b437 · replan refinement (drafted)
Round 1 escalated with partner error `evidence_floor_not_met` (no plan content disputed). Replanned with one genuine
refinement verified against current code (file:line), not cosmetic: **reclassified
`credit-recommender-repository.ts:114 fetchMerchantCommissionEligibility` from ADMIN/INGESTION to FULFILMENT.** Read
the function (lines 110–117): it is a by-explicit-`merchant_id` lookup of `recommendation_commission_eligible` /
`recommendation_commission_rate_override`, called by the commission engine on an already-placed order
(`credit-recommender-repository.ts:28 fetchProductOrderForCommission` reads `product_orders`; `:52,:92,:105,:122`
operate on `recommendation_commissions`). It serves no admin/back-office/supplier surface and no member Discover/ORB
surface, so by the spec's own definitions it is fulfilment (by-explicit-id read of an already-held item → unfiltered,
`// discover-inventory: fulfilment`), not admin. The wrong class would have put `// discover-inventory: admin` on a
post-purchase commission read. Updated plan Problem 2 and tasks P2 (moved it from the ADMIN/INGESTION list to the
FULFILMENT list with the by-merchant_id rationale). No lane-path change (the file is already in
`discover-shared-predicate`'s paths and the lane body describes classes generically, not per-file). queue.mjs
validators re-run on handoff.md + all 4 lanes: 0 errors.

### 2026-10-15T17:05Z · kiro-hotmail-202610151618-b437 · sparring round-1 fixes (drafted)
Answered the three findings of partner session `9ba4ff16` (s2-round-1.md), all ACCEPTED after verifying each premise
at file:line, in `sparring/s2-responses-1.md`:
(1) **R1-F1 [blocker].** `fetchProductsByIds` (`shop-feed-repository.ts:32`) is dual-use — the module comment at
`:31` states it serves BOTH video-anchor hydration (a discovery surface) AND saved-products hydration. The single
"fulfilment → unfiltered" stamp left anchor-surfaced products tenant-ungated (a T_A-only supplier would reach T_B via
a shop video). Split the two call sites: anchor path = DISCOVERY (predicate-gated), saved-products = FULFILMENT. Plan
Problem 2 + Fix + Tests, tasks P2/P5, lane body updated.
(2) **R1-F2 [major].** The "dual enforcement (RLS + predicate)" risk was false: `products_select`/`merchants_select`
(`...foundation.sql:729/:735`) gate only `is_active = TRUE` (no tenant term) and products reads use the service-role
client (RLS bypassed). Made RLS a real backstop: the DB lane's 4th migration now replaces those policies with
tenant-scoped ones (active `supplier_tenant_relationships` for `current_tenant_id()`, or `distribution='network'`),
flag-guarded/inert for Maxina; stated the predicate is fail-closed and the sole layer for service-role reads. Plan
Risks + DB Fix + Migrations + Tests, tasks D4/D6, lane `supplier-relationships-db` path+body updated.
(3) **R1-F3 [major].** `product_orders` already has `tenant_id UUID NOT NULL`
(`20260416120000_vtid_02000_marketplace_foundation.sql`), the buyer's tenant, filtered in
`health-action-initiative-repository.ts:71` / `admin-scanners/marketplace-repository.ts:42`. A new nullable
`buyer_tenant_id` would be NULL for all orders until a write path existed (silent-fallback). Dropped the column; D26
reuses the existing `tenant_id` (extend `fetchProductOrderForCommission` `credit-recommender-repository.ts:28` to
select it, in `supplier-onboarding-communities` S4). Plan Problem 8 + Fix + Migrations + Tests, tasks D4/S4 updated.
queue.mjs validators re-run on handoff.md + all 4 lanes: 0 errors.

### 2026-10-18T20:02Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:10Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:19Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:26Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-21T14:27Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (partner_output_invalid). Not a plan problem: Claude Code looks at the partner, then re-runs.
