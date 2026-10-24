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
   (`docs/COMMERCE-SUPPLIER-INFRASTRUCTURE-ARCHITECTURE.md` §7/§5.7). No tenant↔supplier eligibility exists; every
   Discover reader is global.
2. Every `products`/`merchants` reader filters only `is_active`/`availability`, no tenant/supplier gate, and there is
   no single predicate. A fresh `from('products')|from('merchants')` sweep of `services/gateway/src` (2026-10-17) is
   the plan-of-record list; **design "What exists" + tasks P2 carry the full file:line set** across three classes —
   **discovery** (open feed/search/browse + the by-id discovery initiator `services/gateway/src/routes/discover-recommendations-repository.ts:22-23` `fetchActiveProductForRecommendation` (Recommend & Earn share-link mint, `routes/discover-recommendations.ts`)),
   **fulfilment** (by-explicit-id hydration of an already-held item), **admin/ingestion** (admin/supplier surface by
   `merchant_id`/org). Two classification corrections verified this round: (a) `credit-recommender-repository.ts:112
   fetchMerchantCommissionEligibility` is a by-`merchant_id` commission read on an already-placed order (no
   admin/member surface) → fulfilment, not admin; (b) **R1-F1** — `services/gateway/src/routes/shop-feed-repository.ts:32 fetchProductsByIds` is
   dual-use (module comment `:31`: reused for BOTH video-anchor hydration AND saved-products hydration), so its
   anchor call site is a discovery surface that MUST carry the predicate and is split from the saved-products
   fulfilment call site. `routes/shop-feed-repository.ts:43 fetchRankedShopVideosPage` reads `shop_videos` only, out of
   scope. The lane `paths` cover the full swept set so the build-failing lint can annotate/route each file in-scope
   (else Lane-scope CI fails the first touch).
3. `tenant_catalog_overrides` exists (foundation migration `20260416120000_vtid_02000_marketplace_foundation.sql:326`;
   RLS at `:807-812`: `tenant_catalog_overrides_select … FOR SELECT TO authenticated USING (tenant_id =
   public.current_tenant_id())` and `tenant_catalog_overrides_service … FOR ALL TO service_role`; `GRANT SELECT … TO
   authenticated` `:857`) but is enforced nowhere (commerce architecture: "exists but
   is not enforced anywhere").
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
   recommender platform-wide with no tenant attribution (D26). `product_orders` ALREADY has a buyer-tenant column `tenant_id`
   (created `UUID NOT NULL` in `20260416120000_vtid_02000_marketplace_foundation.sql:529`, made NULLABLE by
   `20260929120200_vtid_04740_product_orders_tenant_nullable.sql:12` — NULL for a signed-out buyer's anonymous referral
   sale), but `fetchProductOrderForCommission` (`credit-recommender-repository.ts:26-32`) does not select it.
9. Health-category offerings (labs, practitioners) have no trust-level-2 + DPA gate before listing.
10. The lineage guard (§4.9/§4.10): no build-failing test stops a `products`/`merchants` reader query from reading
    `health_*`/`wearable_*`/`biomarker_*`/`lab_*`/`vitana_index_*`. It must be per-query, because
    `services/gateway/src/services/automation-handlers/health-wellness-repository.ts` (products `:90-92` vs health `:28/:32/:44/:50/:55/:68`) and
    `services/gateway/src/services/automation-handlers/health-action-initiative-repository.ts` (products `:81` vs health `:26/:54/:60/:64`) each read `products` in one
    function AND health tables in sibling functions — a module-granular guard would RED-flag this existing, unrelated
    code.

## Fix (per lane)
- **supplier-relationships-db** (DB, repo vitana-platform): create `supplier_tenant_relationships`
  (supplier/org id, tenant_id FK, status `proposed|active|declined|suspended`, scope/vertical, timestamps; RLS:
  tenant-member read via an inline `user_tenants` EXISTS (no mt-identity helper), service-role write; a migration default makes existing network merchants
  `active` for Maxina only — D7); add `products.distribution text NOT NULL DEFAULT 'community'
  CHECK (distribution IN ('community','network'))` expand/contract (default stays, existing rows → `community`,
  active for Maxina only); backfill `partner_tenant.tenant_id` free-text → real tenant UUID or NULL (platform),
  referenced by — not duplicated in — `supplier_tenant_relationships` (ALWAYS 9). NO new order-tenant column: the existing nullable `product_orders.tenant_id` already IS the buyer's tenant (written
  by checkout and the Awin sync; NULL only for anonymous buyers, VTID-04740) — a second `buyer_tenant_id` column would
  duplicate it. D26 attribution (`supplier-onboarding-communities` S4) reads the existing buyer-tenant column `product_orders.tenant_id`, which is NULLABLE since VTID-04740 (`20260929120200_vtid_04740_product_orders_tenant_nullable.sql:12`, column comment: NULL = signed-out buyer of an anonymous referral sale; the Awin sync copies the click's tenant, `product_clicks.tenant_id` also nullable). Rule: `buyer_tenant_id = product_orders.tenant_id`, with an explicit `buyer_tenant_source`: `'order'` when non-NULL, `'anonymous_buyer'` when NULL — NULL is recorded as the honest value and labelled, never replaced by the recommender's tenant, the platform tenant or `DEFAULT_TENANT_ID`. Recommender earnings follow `recommender_tenant_id = resolvePrimaryTenant(recommender_user_id)` (`services/tenancy/tenant-context.ts:43`; the recommender is always a signed-in member). M2 carries the three fields on the commission's OASIS events and the credit result; persisting them as ledger columns on `recommendation_commissions` belongs to the per-tenant money work (M3, Out of scope), so no migration here. **RLS backstop with NO mt-identity dependency (R3-F2):** `is_member()` and `tenant_id_for_policies()` do not exist in `supabase/migrations/**` today, so this spec's migrations use only functions that exist: `public.current_tenant_id()` (`20260218000000_fix_maxina_signup_tenant_association.sql:33`, granted to authenticated/service_role `:105-106`) and an inline `EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.tenant_id = … AND ut.user_id = auth.uid())` (precedent `20261010180200_vtid_05043_s3_switch_tenant_open_signup_only.sql:65`) for the `supplier_tenant_relationships` member read. The new `products_select`/`merchants_select` policy is `is_active AND (NOT public.discover_tenant_gate_enabled() OR distribution = 'network' OR EXISTS (active supplier_tenant_relationships for merchant_id AND tenant_id = public.current_tenant_id()))`, where `discover_tenant_gate_enabled()` is a new `STABLE SECURITY DEFINER` helper with `SET search_path = public, pg_catalog` that returns `coalesce((tenant_settings.feature_flags->'mt'->>'discover_tenant_gate')::boolean, false)` for `current_tenant_id()` and `false` when that is NULL or no row exists. Gate off (the default, and every tenant today) ⇒ the policy reduces to today's `is_active` exactly; gate on with a NULL tenant (signed-out) ⇒ only `network` rows, never an error. When mt-identity ships its helpers, swapping the inline EXISTS for `is_member()` is a tracked follow-up, not a prerequisite. Make RLS a REAL backstop
  (R1-F2): today `products_select`/`merchants_select`
  (`20260416120000_vtid_02000_marketplace_foundation.sql:729/:735`) gate only `is_active = TRUE` with no tenant term;
  replace each with the gate-guarded tenant-scoped policy above, inert while `discover_tenant_gate_enabled()` is false
  (D7). This backstops authenticated/user-JWT reads only; the predicate stays the enforcement layer for
  service-role reads (which bypass RLS). Migrations in range
  20261101120000–20261101125959, rollback files, MIGRATION-QUEUE rows at the WS11 position, read-only pre/post
  checks. DB applied by Claude via RUN-MIGRATION after merge.
- **discover-shared-predicate** (CODE, repo vitana-platform): ONE shared Discover visibility predicate module
  `services/gateway/src/services/discover/tenant-visibility.ts` — v1 = `is_active` AND active
  `supplier_tenant_relationships` for the resolved tenant AND no `tenant_catalog_overrides` hide (both modes; the
  predicate runs on the gateway's service-role client — `getSupabase()` — which bypasses RLS, so it reads overrides
  with an explicit `.eq('tenant_id', resolvedTenantId)` filter; the `:809-811` `current_tenant_id()` policy is only a
  user-JWT backstop, never relied on), PLUS
  the scope term (`distribution='community'` → tenant has an active relationship; `'network'` → every tenant). The
  predicate serves the three
  reader classes defined in Problem 2 / design "What exists" (discovery = FULL predicate; fulfilment = by-id
  hydration, unfiltered so an order is never 404'd when a supplier is later suspended; admin/ingestion = unfiltered,
  admin-guarded). A GENERATED inventory (`scripts/ci/discover-reader-inventory.*`, sweeping ALL of `services/gateway/src/**` — `routes/**` and `services/**` alike — for `.from('products')`/`.from('merchants')`) tags each reader per CALL SITE
  `discovery|fulfilment|admin`; a build-failing lint asserts discovery goes through the predicate, fulfilment is
  annotated `// discover-inventory: fulfilment`, admin `// discover-inventory: admin`, and anything unclassified
  fails. The dual-use `fetchProductsByIds` (`services/gateway/src/routes/shop-feed-repository.ts:32`, R1-F1) is split so its anchor call site lints as
  discovery. Health-category offerings additionally require
  the Health plan trust level 2 + signed DPA before listing (gate in the predicate, discovery class). Add a
  **per-query** lineage guard (the §7.2 ranking-guard idea applied per-query, not per-module): it fails only when the
  SAME query that reads `products`/`merchants` also touches
  `health_*`/`wearable_*`/`biomarker_*`/`lab_*`/`vitana_index_*`, tolerating the mixed files of Problem 10
  (sibling-function health reads). Dark behind `MT_RESOLUTION_V2` + `mt.discover_tenant_gate` / `mt.network_enabled`.
  **Automation discovery reader (R3-F1):** `services/gateway/src/services/automation-handlers/health-wellness-repository.ts:90-92` `fetchActiveProductsByTopicKeys` (AP-0615 health-aware product recs, called from `health-wellness.ts:271`) is tagged `discovery`; it gains a `tenantId` parameter fed from the automation context already in scope (`const { supabase, tenantId } = ctx`, `health-wellness.ts:261`, the same tenant its sibling `fetchRecentRecommendations` uses) and goes through the predicate — no new tenant resolution path. Includes the Discover isolation suite (a supplier active only in T_A never in T_B discovery incl. ORB and incl. the
  shop-video anchor path; a fulfilment-by-id read of a known T_A product still resolves).
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
- `20261101120300_vtid_xxxxx_products_merchants_tenant_rls.sql` (replace `products_select`/`merchants_select` with
  the tenant-scoped policies above as a real RLS backstop, R1-F2; flag-guarded so inert for Maxina). No
  `product_orders` column — D26 reuses the existing `product_orders.tenant_id` (R1-F3).
Each has a pre-approved rollback under `docs/validation/<vtid>/`, read-only `live-before.sql` / `post-apply-checks.sql`,
`lock_timeout` + retries, and a MIGRATION-QUEUE.md row at the WS11 position (after M1/M2 lanes, depends on A-M1
`tenants.is_default`/`is_platform` and mt-identity policy classification). Not-yet-live tables are added to
`scripts/ci/migration-drift-baseline.json` and removed in the PR after apply. DB applied by Claude via RUN-MIGRATION.

## Tests
- Vitest/Jest (gateway): predicate (community/network scope, overrides hide both modes, relationship active/inactive,
  health trust-2+DPA gate); the generated inventory lint; the per-query lineage guard (fails on a health_* read in
  the SAME query as a products read; passes a mixed-module sibling health read); onboarding "which communities"
  creates `proposed` rows and accept/decline flips state; referral attribution reads the existing
  `product_orders.tenant_id`: a signed-in buyer's order gives `buyer_tenant_source:'order'` with that tenant; an
  anonymous (NULL) order gives `buyer_tenant_id:null, buyer_tenant_source:'anonymous_buyer'` — never the recommender's,
  platform or default tenant; `recommender_tenant_id` = the recommender's primary tenant; the override read carries
  an explicit tenant filter (service role).
- pgTAP: `supplier_tenant_relationships` RLS (T_B member reads 0 T_A rows); `products.distribution` CHECK;
  default-active-for-maxina seed; the new tenant-scoped `products`/`merchants` RLS (R1-F2: a user-JWT T_B read
  returns 0 rows for a T_A-only supplier; a `network` product visible to both; gate off → policy result identical
  to the old `is_active`-only policy for every tenant; gate on + NULL `current_tenant_id()` → network rows only, no
  error; `discover_tenant_gate_enabled()` false when no `tenant_settings` row); the migrations reference no
  `is_member()`/`tenant_id_for_policies()`.
- Discover isolation suite (contract): a supplier active only in T_A never in T_B feed/search/ORB **nor via a
  shop-video anchor** (R1-F1); a network offering in both; a `tenant_catalog_overrides` hide removes it in both modes;
  a FULFILMENT by-id read (saved-products/cart/checkout) of a known T_A product still resolves when the supplier is
  suspended for the reader's tenant (no mid-checkout 404).
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
Dark by default: `MT_RESOLUTION_V2` master + `tenant_settings.feature_flags.mt.discover_tenant_gate` /
`mt.network_enabled`. DB changes follow the §4.7 slice protocol, applied by Claude via RUN-MIGRATION after merge in
MIGRATION-QUEUE order; no owner-only step beyond the standard apply approval. Discover becomes tenant-gated from the
first non-Maxina tenant (M2); existing products stay `community`, active for Maxina only (D7), so Maxina Discover is
unchanged while the flag is off.

## Risks
- Missing a `products`/`merchants` reader leaves a global leak, or forces an out-of-paths edit that fails Lane-scope
  CI. Mitigation: the GENERATED inventory + build-failing lint (three classes: discovery/fulfilment/admin), not a
  hand-list; the lane's `paths` cover the FULL 2026-10-17 sweep so every reader can be annotated/routed in-scope;
  every new reader must register or the build fails.
- `partner_tenant.tenant_id` backfill mis-maps a supplier. Mitigation: snapshot `bak_*`, map only unambiguous
  rows, free text that is not a resolvable tenant → NULL (platform); reviewed read-only post-check.
- Enforcement layering (R1-F2). The predicate is the enforcement layer for ALL reads incl. service-role (which bypass
  RLS) and is fail-CLOSED (unresolved tenant or predicate error → no rows). The old `is_active`-only RLS was not a
  real backstop; the new tenant-scoped RLS backstops user-JWT reads. Isolation suite asserts the predicate; pgTAP the
  RLS.
- A module-granular lineage guard would RED-flag mixed files. Mitigation: per-query guard (above); tests pin a
  sibling health read does not fail a `products` reader.

## Out of scope
- The full eligibility engine (commerce arch step 5 requirement rules) — M2 is the v1 predicate only.
- Commission rules/ledger cut-over (commerce arch steps 8–9); per-tenant money (M3, D2/D9).
- `platform_only_accounts` VIEW — created by mt-community-isolation M2; this spec only references it (CROSS-SPEC O5).
- Network groups (live only in mt-network); messenger scope (mt-network); the health tables' own re-keying (WS10).

## Depends on
- Specs/lanes: mt-identity — NOT a prerequisite (R3-F2): this spec uses the existing `current_tenant_id()` and an inline
  `user_tenants` EXISTS; adopting mt-identity's `is_member()`/`tenant_id_for_policies()` once they ship is a tracked
  follow-up; mt-community-isolation M2 (`platform_only_accounts` view, referenced not created, O5); mt-network owns the
  messenger/Network-groups scope (this spec owns only Discover + offering distribution).
- Done VTIDs: VTID-05149/05150/05151 (M0 — `is_default`/`is_platform`, `provision_tenant`, public registry; in
  production). Commerce arch VTID-04732 (design, not built).

## Owner decisions
- D7 (existing suppliers `distribution=community`, active for Maxina only), D26 (referral/commission attribution
  across tenants) — DECIDED, implemented here. No new owner decision; the v1-predicate-only scope for M2 follows
  §4.10/§4.11. The platform tenant + `signup_intent=commerce` path follows O5 and §4.10 (DECIDED).
<!-- plan:end -->

## Open questions for sparring
- D26 precise split when recommender's tenant ≠ buyer's tenant follows commerce arch §9; the exact revenue-share
  formula is deferred to the commerce program — mt-discover carries only the buyer-tenant attribution (reading the
  existing `product_orders.tenant_id`), not the split math.
- Whether the health-category trust-2 + DPA gate reads from a Health-plan table that is not yet created at M2; if
  so, the gate ships behind `mt.discover_health_category` and defaults closed (no health offerings listed) until
  the Health plan lands.
