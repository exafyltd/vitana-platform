---
change_class: standard
---
# mt-discover — Commerce & Discover × tenancy (WS11 + Discover scope of §4.11)

<!-- plan:begin -->
## Problem
Verified against platform `origin/main` 2026-10-15 (file:line current unless noted). WS11 makes Discover
tenant-gated and adds the Community/Network scope, on top of the global supplier registry (VTID-04732).

1. `supplier_tenant_relationships` does not exist — grep of `supabase/migrations/**` and `services/gateway/src/**`
   returns zero matches (confirmed 2026-10-15). The commerce architecture designs it
   (`docs/COMMERCE-SUPPLIER-INFRASTRUCTURE-ARCHITECTURE.md` §7 step 7, §5.7, the §"what makes an offering visible"
   list). So no tenant↔supplier eligibility exists; every Discover reader is global.
2. Every `products`/`merchants` reader filters only `is_active`/`availability`, no tenant/supplier gate, and there is
   no single predicate. A fresh `from('products')|from('merchants')` sweep of `services/gateway/src` (2026-10-17) is
   the plan-of-record list the generated inventory must reproduce; design "What exists" carries the full file:line
   set, classified **discovery** (12 readers: open feed/search/browse + the by-id discovery initiator
   `discover-recommendations-repository.ts:23`), **fulfilment** (by-id hydration of an already-held item, incl.
   `shop-feed:32`, `cart-checkout:36/:41`, `checkout:42`, `health-action-initiative:81`, `universal-cart-context:45`,
   `reorder-core:24`, `click-redirect:20`, and `credit-recommender-repository.ts:114 fetchMerchantCommissionEligibility`
   — a by-explicit-`merchant_id` commission-eligibility read on an already-placed order, no admin/member surface, so
   fulfilment not admin), and **admin/ingestion** (admin/supplier surface by `merchant_id`/org:
   admin-marketplace, catalog-ingest, the two marketplace-sync + shopify-sync repos, vcaop-portal, partner-onboarding*,
   partner-review/setup, admin-scanners/marketplace). The 2026-10-17 sweep added the orb-tools
   `marketplace-*-repository`, `gemini-operator`, `intent-matcher`, the analyzer and shopping-agent repos the earlier
   draft hand-listed around, so the lane `paths` now cover the full set and the build-failing lint can annotate/route
   each file in-scope (else Lane-scope CI fails the first touch). `shop-feed-repository.ts:43 fetchRankedShopVideosPage`
   reads `shop_videos` only, NOT `products`/`merchants`, out of scope.
3. `tenant_catalog_overrides` exists (foundation migration `20260416120000_vtid_02000_marketplace_foundation.sql`,
   RLS `_select` bare `tenant_id = current_tenant_id()`) but is enforced nowhere — the commerce architecture
   confirms "exists but is not enforced anywhere" (§"Partner↔tenant relationship" row).
4. `products` has no `distribution` column (no match for `distribution` in the marketplace migrations), so no
   community-vs-network offering split. The Discover feed is fully global today.
5. `partner_tenant.tenant_id` is free text written `caller.tenantId || 'platform'`
   (`services/gateway/src/services/partner-onboarding-service.ts:948`), not a real tenant UUID — supplier identity
   is not tied to a tenant row.
6. Supplier onboarding (`partner-onboarding-service.ts`, `routes/partner-onboarding*.ts`) has no "which communities"
   step and no tenant accept/decline; commerce signup historically hardcodes `tenant_slug:'maxina'` (per onboarding
   spec, already required to drop it).
7. The Discover scope control: the mobile mode switch is `MobileModePill`/`SplitBar` in the utility bar
   (SPOTLIGHT_RULES.md §D). Discover's own tab pill (`src/pages/Discover.tsx`) is the tab selector, NOT a scope
   control — §4.11 requires a SEPARATE scope control for Community/Network Discover mode.
8. Referral earnings (`services/gateway/src/services/recommendation-commissions/credit-recommender.ts`) credit the
   recommender platform-wide with no tenant attribution (D26).
9. Health-category offerings (labs, practitioners) have no trust-level-2 + DPA gate before listing.
10. The lineage guard (§4.9/§4.10): no build-failing test stops a `products`/`merchants` reader query from reading
    `health_*`/`wearable_*`/`biomarker_*`/`lab_*`/`vitana_index_*`. It must be per-query, because
    `health-wellness-repository.ts` and `health-action-initiative-repository.ts` each read `products` in one function
    AND health tables in sibling functions (verified: `health-wellness-repository.ts:91` products vs `:28,:32,:44,:50,
    :55,:68` health; `health-action-initiative-repository.ts:81` products vs `:26,:30,:54,:60,:64` health) — a
    module-granular guard would turn RED on this existing, unrelated code.

## Fix (per lane)
- **supplier-relationships-db** (DB, repo vitana-platform): create `supplier_tenant_relationships`
  (supplier/org id, tenant_id FK, status `proposed|active|declined|suspended`, scope/vertical, timestamps; RLS:
  tenant-member read via `is_member`, service-role write; a migration default makes existing network merchants
  `active` for Maxina only — D7); add `products.distribution text NOT NULL DEFAULT 'community'
  CHECK (distribution IN ('community','network'))` expand/contract (default stays, existing rows → `community`,
  active for Maxina only); backfill `partner_tenant.tenant_id` free-text → real tenant UUID or NULL (platform),
  referenced by — not duplicated in — `supplier_tenant_relationships` (ALWAYS 9); add
  `product_orders.buyer_tenant_id uuid` (nullable, expand-only, no default) carrying the purchase's tenant (D26) —
  the commission-attribution row (`credit-recommender-repository.ts:28`); `recommendation_commissions` already
  carries `recommender_user_id`, so no column there; added dark, read only by S4. Migrations in range
  20261101120000–20261101125959, rollback files, MIGRATION-QUEUE rows at the WS11 position, read-only pre/post
  checks. DB applied by Claude via RUN-MIGRATION after merge.
- **discover-shared-predicate** (CODE, repo vitana-platform): ONE shared Discover visibility predicate module
  `services/gateway/src/services/discover/tenant-visibility.ts` — v1 = `products.is_active`
  AND `supplier_tenant_relationships` active for the resolved tenant AND no `tenant_catalog_overrides` hide for that
  tenant, PLUS the scope term (`distribution = 'community'` → tenant has an active relationship; `'network'` →
  every tenant), with the `tenant_catalog_overrides` hide applied in BOTH modes. The predicate serves THREE reader
  classes (full list + rationale in design "What exists"/Rule 3; Problem 2 enumerates them): **discovery** (FULL
  predicate); **fulfilment** (by-id hydration of an already-held item, unfiltered, so an order is never 404'd when a
  supplier is later suspended); **admin/ingestion** (admin/supplier surface by `merchant_id`/org, unfiltered). A
  GENERATED inventory (`scripts/ci/discover-reader-inventory.*`) tags each reader `discovery|fulfilment|admin`; a
  build-failing lint asserts discovery goes through the predicate, fulfilment is annotated `// discover-inventory:
  fulfilment`, admin `// discover-inventory: admin` (both unfiltered), and anything unclassified fails. The lane's
  `paths` cover the full swept set so the lint can annotate/route each file without the PR leaving scope.
  `shop-feed-repository.ts:43 fetchRankedShopVideosPage` reads `shop_videos`, is NOT a `products`/`merchants` reader,
  out of scope. Health-category offerings additionally require
  the Health plan trust level 2 + signed DPA before listing (gate in the predicate, discovery class). Add a
  **per-query** lineage guard (the §7.2 ranking-guard idea applied per-query, not per-module): it fails only when the
  SAME query that reads `products`/`merchants` also touches
  `health_*`/`wearable_*`/`biomarker_*`/`lab_*`/`vitana_index_*`, and MUST NOT flag an unrelated sibling function in
  the same file — `health-wellness-repository.ts` and `health-action-initiative-repository.ts` are the known mixed
  files (health reads in sibling functions, not in the `products` reader) and the guard must tolerate them.
  Dark behind `MT_RESOLUTION_V2` + `mt.discover_tenant_gate` / `mt.network_enabled`. Includes the Discover isolation
  suite (a supplier active only in T_A never in T_B discovery incl. ORB; a fulfilment-by-id read of a known T_A
  product still resolves).
- **supplier-onboarding-communities** (CODE, repo vitana-platform): add the "which communities" step to supplier
  onboarding (portal + Commerce MCP + voice) that creates `proposed` `supplier_tenant_relationships` rows; a tenant
  accept/decline API flips `proposed→active|declined`. Platform tenant + `signup_intent='commerce'` path:
  commerce signup drops hardcoded Maxina; `signup_intent` (untrusted client metadata) can only route to the
  platform path, never grant anything (platform tenant per O5/§4.10). Referral/commission attribution carries the
  buyer's tenant; recommender earnings follow the recommender's tenant (D26). Dark behind the mt flags.
- **discover-mode-ui** (CODE, repo vitana-v1): a SEPARATE Discover Community/Network scope control (not the Discover
  tab pill, not `MobileModePill`), default Community, remembered per surface; the supplier "which communities" and
  tenant accept/decline UI follow the Commerce UX contract (AI-led, one dominant action, no internal concepts, "UX
  acceptance" PR section). Spotlight, i18n DE-first du-form, RTL. Dark behind `mt.network_enabled`; no new App.tsx
  route (control on the existing Discover screen) → no nav-registry / screen-manifest / parity-ledger change (if a
  route is added, those three updates ship in the lane).

## Migrations
Lane supplier-relationships-db, version range 20261101120000–20261101125959 (executor renumbers if a later
migration exists at implementation):
- `20261101120000_vtid_xxxxx_supplier_tenant_relationships.sql` (+ default-active-for-maxina seed, expand only).
- `20261101120100_vtid_xxxxx_products_distribution.sql` (expand/contract: add column with DEFAULT 'community',
  backfill, then drop default per §4.7).
- `20261101120200_vtid_xxxxx_partner_tenant_backfill.sql` (free-text tenant_id → UUID/NULL; snapshot `bak_*` first).
- `20261101120300_vtid_xxxxx_referral_tenant_attribution.sql` (`ALTER TABLE product_orders ADD COLUMN
  buyer_tenant_id uuid` — nullable, expand-only, no default; read by S4 only).
Each has a pre-approved rollback under `docs/validation/<vtid>/`, read-only `live-before.sql` / `post-apply-checks.sql`,
`lock_timeout` + retries, and a MIGRATION-QUEUE.md row at the WS11 position (after M1/M2 lanes, depends on A-M1
`tenants.is_default`/`is_platform` and mt-identity policy classification). Not-yet-live tables are added to
`scripts/ci/migration-drift-baseline.json` and removed in the PR after apply. DB applied by Claude via RUN-MIGRATION.

## Tests
- Vitest/Jest (gateway): the shared predicate (community/network scope, overrides hide in both modes, supplier
  relationship active/inactive, health-category trust-2+DPA gate); the generated reader inventory lint; the lineage
  guard (per-query: fails on a health_* read in the SAME query as a products read; passes a mixed-module file whose
  health read is a sibling function); supplier onboarding "which communities" creates `proposed` rows and
  accept/decline flips state; referral attribution carries the buyer's tenant.
- pgTAP: `supplier_tenant_relationships` RLS (T_B member reads 0 T_A rows); `products.distribution` CHECK;
  default-active-for-maxina seed.
- Discover isolation suite (contract): a supplier active only in T_A never in T_B feed/search/ORB; a network offering
  in both; a `tenant_catalog_overrides` hide removes it in both modes in that tenant; a FULFILMENT by-id read of a
  known T_A product still resolves when the supplier is suspended for the reader's tenant (no mid-checkout 404).
- Vitest (vitana-v1): the Discover scope control (default Community, per-surface memory, separate from the tab
  pill); supplier "which communities" + accept/decline UI validation; no write request on render.
- Required suites when touched: `npm run test:support` (42c), `npm run test:operator` (42e); ORB dispatcher tests on
  Nova and the Vertex Serbian bridge for the product/cart scope rule (42h/§4.9 dispatcher rule) if the ORB tool
  dispatch is changed.
- Staging (read-only, rule 48): the Discover scope control renders and defaults to Community for the test user;
  network guard aborts any non-GET; no write path exercised.

## Staging verification
Read-only (rule 48): staging uses production Supabase; specs sign in, navigate and read only; the network guard
aborts every non-GET to the gateway/Supabase except sign-in. The tenant-gating and onboarding writes are proven by
Vitest/pgTAP only (no second real tenant on staging). No suite points at `vitanaland.com`.

## Rollout
Dark by default: `MT_RESOLUTION_V2` master + `tenant_settings.feature_flags.mt.discover_tenant_gate` and
`mt.network_enabled` (Network surfaces). DB changes follow the §4.7 slice protocol, applied by Claude via
RUN-MIGRATION after merge in MIGRATION-QUEUE order; owner-only step: none beyond the standard apply approval.
Discover becomes tenant-gated from the first non-Maxina tenant (M2); existing products stay `community`, active for
Maxina only (D7), so Maxina Discover is unchanged while the flag is off.

## Risks
- Missing a `products`/`merchants` reader leaves a global leak, or forces an out-of-paths edit that fails Lane-scope
  CI. Mitigation: the GENERATED inventory + build-failing lint (three classes: discovery/fulfilment/admin), not a
  hand-list; the lane's `paths` cover the FULL 2026-10-17 sweep so every reader can be annotated/routed in-scope;
  every new reader must register or the build fails.
- `partner_tenant.tenant_id` backfill mis-maps a supplier. Mitigation: snapshot `bak_*`, map only unambiguous
  rows, free text that is not a resolvable tenant → NULL (platform); reviewed read-only post-check.
- Dual enforcement (RLS + predicate) could diverge. Mitigation: predicate is the single read path, RLS the backstop;
  the isolation suite asserts both.
- A module-granular lineage guard would RED-flag existing mixed files. Mitigation: the guard is per-query (above);
  tests pin that a sibling health read in the same file does not fail a `products` reader.

## Out of scope
- The full eligibility engine (commerce arch step 5 requirement rules) — M2 is the v1 predicate only.
- Commission rules/ledger cut-over (commerce arch steps 8–9); per-tenant money (M3, D2/D9).
- `platform_only_accounts` VIEW — created by mt-community-isolation M2; this spec only references it (CROSS-SPEC O5).
- Network groups (live only in mt-network); messenger scope (mt-network); the health tables' own re-keying (WS10).

## Depends on
- Specs/lanes: mt-identity (`tenant_id_for_policies()`, `is_member()`, policy classification; the predicate uses
  them); mt-community-isolation M2 (`platform_only_accounts` view — referenced, not created, O5); mt-network owns
  the messenger/Network-groups scope (this spec owns only Discover + offering distribution).
- Done VTIDs: VTID-05149 (`tenants.is_default`/`is_platform`), VTID-05150 (`provision_tenant`), VTID-05151
  (public registry) — M0, in production. Commerce architecture VTID-04732 (design, not built).

## Owner decisions
- D7 (existing suppliers `distribution=community`, active for Maxina only), D26 (referral/commission attribution
  across tenants) — DECIDED, implemented here. No new owner decision; the v1-predicate-only scope for M2 follows
  §4.10/§4.11. The platform tenant + `signup_intent=commerce` path follows O5 and §4.10 (DECIDED).
<!-- plan:end -->

## Open questions for sparring
- D26 precise split when recommender's tenant ≠ buyer's tenant follows commerce arch §9; the exact revenue-share
  formula is deferred to the commerce program — mt-discover carries only the attribution columns + buyer-tenant
  attribution, not the split math.
- Whether the health-category trust-2 + DPA gate reads from a Health-plan table that is not yet created at M2; if
  so, the gate ships behind `mt.discover_health_category` and defaults closed (no health offerings listed) until
  the Health plan lands.
