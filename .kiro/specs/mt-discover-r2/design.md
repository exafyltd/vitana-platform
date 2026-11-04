# Design — mt-discover (Commerce & Discover × tenancy) — mt-discover-r2 (re-plan)

## What exists (read these, do not copy them)
- `products`/`merchants` readers (all global today, `is_active`/`availability` only) — the FULL set from a fresh
  `from('products')|from('merchants')` sweep of `services/gateway/src` (2026-10-17), classified by the Rule 3 rule.
  This is the plan-of-record list the generated inventory must match.
  - **DISCOVERY (full predicate):** `routes/discover-feed-repository.ts:40`, `routes/discover-search-repository.ts:29,:37`,
    `routes/discover-recommendations-repository.ts:23` (`fetchActiveProductForRecommendation`, by-id initiator),
    `services/orb-tools/marketplace-discovery-tools-repository.ts` (`searchProducts:34`, `searchProductByTitleTop1:47`,
    `fetchProductsByCategory:51`, `fetchDealsProducts:68`, `fetchProductById:43`),
    `services/orb-tools/marketplace-va-shared-repository.ts` (`fetchProductByFuzzyTitle:44`, `fetchProductById:35`),
    `services/orb-tools/marketplace-guide-tools-repository.ts:42,:55`,
    `services/orb-tools/marketplace-journey-tools-repository.ts:33,:67`,
    `services/automation-handlers/health-wellness-repository.ts:90-92` (`fetchActiveProductsByTopicKeys`, AP-0615; gains `tenantId` from `ctx.tenantId`, `health-wellness.ts:261`),
    `services/gemini-operator-repository.ts:39,:62` (operator product search + `fetchDiscoverFeed`),
    `services/intent-matcher-repository.ts:32` (`fetchProductsByParentCategory`),
    `services/recommendation-engine/analyzers/marketplace-analyzer-repository.ts:40` (`buildCandidateProductsQuery`),
    `services/shopping-agent/agent-core-repository.ts:27` (`buildCandidateProductsAgentQuery`). NOTE: the ORB callers
    `marketplace-discovery-tools.ts` import `* as repo` from `marketplace-discovery-tools-repository.ts` — the queries
    live in the `-repository` file, so that is the file the predicate wiring edits.
  - **FULFILMENT (by-id hydration; unfiltered + `// discover-inventory: fulfilment`):** `routes/shop-feed-repository.ts:32`
    (`fetchProductsByIds`), `services/orb-tools/cart-checkout-tools-repository.ts:36` (`fetchProductsByIds`), `:41`
    (`fetchProductById`) — but `:45 searchActiveProductsByTitle` is an open title search = DISCOVERY;
    `services/checkout/checkout-service-repository.ts:42` (`fetchProductsByIds`),
    `services/automation-handlers/health-action-initiative-repository.ts:81` (`fetchProductById`),
    `routes/universal-cart-context-repository.ts:45` (`fetchProductAvailabilityForVideoShop`),
    `services/shopping-agent/reorder-core-repository.ts:24` (by ids),
    `routes/click-redirect-repository.ts:20` (`fetchActiveProductForRedirect`, redirect of a chosen product),
    `services/orb-tools/marketplace-journey-tools-repository.ts:51,:55` (`fetchProductTitles`/`searchProductsByIds`),
    `services/orb-tools/marketplace-discovery-tools-repository.ts` (`fetchProductTitlesByIds`, `fetchProductTitleById`).
  - **ADMIN/INGESTION (unfiltered, admin-guarded + `// discover-inventory: admin`):** `routes/admin-marketplace-repository.ts`
    (products `:28,:30,:83,:106`, merchants `:27,:54`), `routes/catalog-ingest-repository.ts` (ingestion upsert/fetch),
    `routes/vcaop-portal-my-products.ts` (supplier portal, own merchant), `routes/partner-onboarding-catalogue.ts`
    (supplier catalogue insert), `routes/partner-onboarding.ts` (offering counts by merchant_id),
    `services/partner-onboarding-service.ts` (supplier product management by merchant_id), `services/partner-review.ts`
    (`orgMerchantIds`), `services/partner-setup.ts` (merchant setup), `services/shopify-sync-repository.ts`,
    `services/marketplace-sync/shared-repository.ts`, `services/marketplace-sync/amazon-sync-repository.ts` (ingestion
    sync), `services/admin-scanners/marketplace-repository.ts` (admin scanner counts),
    `services/recommendation-commissions/credit-recommender-repository.ts:114` (`fetchMerchantCommissionEligibility`,
    back-office commission).
  - **NOT a `products`/`merchants` reader:** `routes/shop-feed-repository.ts:43 fetchRankedShopVideosPage` reads
    `shop_videos` (its select carries no product id) — out of the predicate's scope.
- `tenant_catalog_overrides`: foundation migration `20260416120000_vtid_02000_marketplace_foundation.sql`
  (`:326`; RLS `:807-812` — authenticated `tenant_id = current_tenant_id()`, service_role all); the predicate reads it
  on the service-role client with an explicit tenant filter; not enforced anywhere today (commerce arch §"Partner↔tenant relationship").
- `partner_tenant.tenant_id` written `caller.tenantId || 'platform'` at
  `services/gateway/src/services/partner-onboarding-service.ts:948`; onboarding routes `routes/partner-onboarding*.ts`.
- Referral/commission: `services/gateway/src/services/recommendation-commissions/credit-recommender.ts`
  (+ `referral-validation.ts`, `credit-recommender-repository.ts`); click attribution `routes/click-redirect.ts`.
- Tenant SQL helpers used: the existing `current_tenant_id()` (`20260218000000…:33`) and an inline `user_tenants` EXISTS
  (precedent `20261010180200…:65`); mt-identity-r2's `is_member()`/`tenant_id_for_policies()` do not exist yet and are a
  later swap, not a dependency. New helper `discover_tenant_gate_enabled()` (STABLE SECURITY DEFINER, pinned
  search_path, false when no tenant/row) guards the products/merchants RLS.
- `platform_only_accounts` view — created by mt-community-isolation-r2 M2 (O5); referenced here, never created.
- Frontend: `vitana-v1/src/pages/Discover.tsx` (tab pill is the tab selector, not a scope); scope mode control is
  `MobileModePill`/`SplitBar` in the utility bar (SPOTLIGHT_RULES.md §D) — the Discover scope control is a THIRD,
  separate control. `useTenant` for tenant context; Commerce UX contract in `vitana-v1/CLAUDE.md`.

## Design per lane
### supplier-relationships-db (DB, vitana-platform)
- `supplier_tenant_relationships(id, supplier_id/org_id, tenant_id uuid REFERENCES tenants, status text CHECK IN
  ('proposed','active','declined','suspended'), vertical/scope, created_at, updated_at, decided_at)`; RLS: SELECT for
  tenant members via an inline `user_tenants` EXISTS on `auth.uid()`, ALL for `service_role`; migration default seeds existing network
  merchants `active` for Maxina only (D7). Not duplicated: references `partner_tenant`/supplier id (ALWAYS 9).
- `products.distribution text NOT NULL DEFAULT 'community' CHECK (distribution IN ('community','network'))` added
  expand/contract (add with default → existing rows `community` → drop default per §4.7).
- `partner_tenant.tenant_id` free text → real tenant UUID or NULL (platform): snapshot `bak_*` first, map only
  unambiguous rows, unresolvable → NULL.
- Referral attribution: NO new column. D26 attribution (`supplier-onboarding-communities` S4) reads the existing buyer-tenant column `product_orders.tenant_id`, which is NULLABLE since VTID-04740 (`20260929120200_vtid_04740_product_orders_tenant_nullable.sql:12`, column comment: NULL = signed-out buyer of an anonymous referral sale; the Awin sync copies the click's tenant, `product_clicks.tenant_id` also nullable). Rule: `buyer_tenant_id = product_orders.tenant_id`, with an explicit `buyer_tenant_source`: `'order'` when non-NULL, `'anonymous_buyer'` when NULL — NULL is recorded as the honest value and labelled, never replaced by the recommender's tenant, the platform tenant or `DEFAULT_TENANT_ID`. Recommender earnings follow `recommender_tenant_id = resolvePrimaryTenant(recommender_user_id)` (`services/tenancy/tenant-context.ts:43`; the recommender is always a signed-in member). M2 carries the three fields on the commission's OASIS events and the credit result; persisting them as ledger columns on `recommendation_commissions` belongs to the per-tenant money work (M3, Out of scope), so no migration here.
- Migrations 20261102120000–120300, each with rollback + `live-before.sql` + `post-apply-checks.sql`,
  `lock_timeout` + retries, a MIGRATION-QUEUE.md row at the WS11 position, drift-baseline entry removed after apply.

### discover-shared-predicate (CODE, vitana-platform)
- `services/gateway/src/services/discover/tenant-visibility.ts`: the single predicate (R1/R2) + the health-category
  trust-2 + DPA gate (R8). The generated inventory sorts every `products`/`merchants` reader into THREE classes
  (verified against current code; full file list in "What exists" above) — a tenant-visibility gate on a hydration
  lookup would 404 an in-flight order, and on an admin/ingestion reader would break back-office/supplier tooling,
  instead of fixing member discovery:
  - **discovery** = a reader that SURFACES offerings the member has not already chosen. That is any open
    feed/search/browse query, AND a by-id lookup that INITIATES a new discovery action (e.g. creating a
    recommendation of a product — it must not succeed for a product not visible in the member's tenant). They apply
    the FULL predicate (relationship + distribution scope + overrides hide + health gate). Verified:
    `discover-feed-repository.ts:40`, `discover-search-repository.ts:29`,
    `orb-tools/marketplace-discovery-tools.ts`, `marketplace-guide-tools-repository.ts:42,55`,
    `marketplace-journey-tools-repository.ts:33,67`, `automation-handlers/health-wellness-repository.ts:90-92`
    (`fetchActiveProductsByTopicKeys`, tenant from `ctx.tenantId`), and the by-id initiator `discover-recommendations-repository.ts:23`
    (`fetchActiveProductForRecommendation`, `.eq('id', productId)`).
  - **fulfilment** = a reader that HYDRATES an item the member already has (cart/saved/in-flight/past order/reorder).
    These resolve a KNOWN item by id and MUST NOT be filtered by relationship/distribution — otherwise a product a
    member saved or has in cart while the supplier was active (now suspended for the tenant) silently 404s
    mid-checkout. Verified: `shop-feed-repository.ts:32 fetchProductsByIds` (anchor + saved-products hydration),
    `orb-tools/cart-checkout-tools-repository.ts:36 fetchProductsByIds`,
    `services/checkout/checkout-service-repository.ts:42 fetchProductsByIds`, and the by-id enrichment
    `automation-handlers/health-action-initiative-repository.ts:81 fetchProductById` (hydrates an existing automation
    context, not an open browse). They may honour an explicit `tenant_catalog_overrides` hide only if product policy
    later wants it, but never relationship/distribution. The inventory lint requires each fulfilment reader to be
    annotated `// discover-inventory: fulfilment`.
  - **admin/ingestion** = a reader served to an ADMIN or SUPPLIER surface, not a member Discover/ORB surface:
    admin marketplace stats/listing, catalog ingestion (sync upserts), and supplier-portal/onboarding reads+writes of
    the supplier's OWN catalogue (authorized by `merchant_id`/org ownership, not by tenant discovery). These MUST NOT
    carry the relationship/distribution predicate — gating them would break back-office moderation, ingestion, and a
    supplier managing their own products. The full list is in "What exists" (admin-marketplace, catalog-ingest,
    vcaop-portal-my-products, partner-onboarding*, partner-review, partner-setup, the marketplace-sync/shopify-sync
    repositories, admin-scanners/marketplace, and the by-id commission eligibility read in
    `credit-recommender-repository.ts:114`). The inventory lint requires each to be annotated
    `// discover-inventory: admin` and left unfiltered.
  - **NOT a `products`/`merchants` reader at all:** `shop-feed-repository.ts:43 fetchRankedShopVideosPage` reads
    `shop_videos` (its select carries no product id), so the products-visibility predicate has nothing to gate there
    and the generated inventory will not detect it. Removed from the discovery list. Tenant scoping of the shop-video
    feed (`shop_videos` ↔ creator/product linkage) is a separate concern, out of scope here.
- `scripts/ci/discover-reader-inventory.*`: GENERATED list of `products`/`merchants` readers tagging each
  `discovery`, `fulfilment` or `admin` by the rule above; a build-failing lint asserts every `discovery` reader goes
  through the predicate, every `fulfilment` reader is annotated `// discover-inventory: fulfilment` and NOT
  relationship/distribution-filtered, every `admin` reader is annotated `// discover-inventory: admin` and
  unfiltered, and anything unclassified fails (R3). The
  lineage guard (R4) is **per-query, not per-module** — the §7.2 ranking-guard idea applied per query: it fails only
  when the SAME query that reads `products`/`merchants` (or that reader function's own join/sub-select) also touches a
  `health_*`/`wearable_*`/`biomarker_*`/`lab_*`/`vitana_index_*` table, and MUST NOT flag an unrelated sibling
  function in the same file. `health-wellness-repository.ts` (products at `:91`; health at `:28,:32,:44,:50,:55,:68`)
  and `health-action-initiative-repository.ts` (products at `:81`; health at `:26,:30,:54,:60,:64`) are the known
  mixed-module files the guard MUST tolerate; a module-granular copy of §7.2 would RED-flag this existing unrelated
  code the instant these files enter the inventory.
- Dark behind `MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.discover_tenant_gate` / `mt.network_enabled`.
- Discover isolation suite: supplier active only in T_A never in T_B (feed/search/ORB); network offering in both;
  override hide removes it in both modes in that tenant.

### supplier-onboarding-communities (CODE, vitana-platform)
- "Which communities" step in `partner-onboarding-service.ts` + the onboarding routes (+ Commerce MCP, voice path):
  creates `proposed` relationships; a tenant accept/decline API flips state (R5).
- Platform tenant + `signup_intent='commerce'` path: drop hardcoded Maxina; `signup_intent` routes only, grants
  nothing (R6, O5/§4.10). Referral attribution carries the buyer's tenant; recommender earnings follow the
  recommender's tenant (R7, D26) — no ranking influence.

### discover-mode-ui (CODE, vitana-v1)
- A separate Discover Community/Network scope control on the Discover screen (not the tab pill, not `MobileModePill`),
  default Community, remembered per surface (R9). Supplier "which communities" + tenant accept/decline UI per the
  Commerce UX contract (R11): AI-led, one dominant action, no internal concepts, "UX acceptance" PR section.
- Spotlight contract (`ScreenFrame`/`VCard`, tokens, logical start/end, skeletons); i18n DE-first du-form; RTL.
- No new App.tsx route (control on the existing Discover screen) → no nav-registry / screen-manifest / parity-ledger
  change. If a new route is added, those three updates ship in this lane.

## Rules every successor follows
1. Migrations apply strictly in `MIGRATION-QUEUE.md` order, one RUN-MIGRATION dispatch per file, by Kiro only after the owner approves the files and the target database (§7d), with
   read-only pre/post checks; new multi-tenant migrations take the next version in the lane range and add their queue
   row in the same PR; a not-yet-live table is added to `scripts/ci/migration-drift-baseline.json` and removed after
   apply.
2. Dark by default (`MT_RESOLUTION_V2`, `tenant_settings.feature_flags.mt.*`); no exception in this spec.
3. ONE shared Discover predicate — never re-implement per surface; new readers register in the generated inventory
   tagged exactly one of three dispositions (anything unclassified fails the build): `discovery` (surfaces
   not-yet-chosen offerings — open query OR a by-id lookup that INITIATES discovery; full predicate); `fulfilment`
   (by-explicit-id hydration of an item the member already has; unfiltered, annotated `// discover-inventory:
   fulfilment`); or `admin` (admin/back-office/supplier-portal + catalog-ingestion readers served to an admin or
   supplier surface, NOT a member Discover/ORB surface; unfiltered, admin-guarded, annotated `// discover-inventory:
   admin`). The surface a reader serves is what distinguishes `admin` from member `discovery`. Never gate a
   fulfilment hydration lookup, nor an admin/ingestion reader, by relationship/distribution.
4. Lineage guard is PER-QUERY: it fails only when the same query that reads `products`/`merchants` also touches
   `health_*`/`wearable_*`/`biomarker_*`/`lab_*`/`vitana_index_*`; it must NOT flag a sibling function in the same
   file (the known mixed files are `health-wellness-repository.ts` and `health-action-initiative-repository.ts`).
5. `platform_only_accounts` is created by mt-community-isolation-r2 M2 (O5); this spec references it only.
6. Network groups and messenger scope live in mt-network-r2; this spec owns only Discover + offering distribution.
7. Production read-only for every session and test (rules 31–32, 48); the executor never writes to a live system
   (collaboration §7a). Supplier onboarding writes are never run against a live system by the executor.
8. Test/service/platform-only accounts never surfaced (rules 43–45); i18n DE-first du-form; RTL via logical
   properties; Spotlight design contract; WCAG 2.2 AA; Commerce UX contract on every supplier screen.
