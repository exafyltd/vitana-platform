# Design — mt-discover (Commerce & Discover × tenancy)

## What exists (read these, do not copy them)
- Discover readers (all global today, `is_active`/`availability` only):
  `services/gateway/src/routes/discover-feed-repository.ts:40`, `discover-search-repository.ts:29`,
  `discover-recommendations-repository.ts:23`, `shop-feed-repository.ts:34`;
  ORB tools `services/gateway/src/services/orb-tools/marketplace-discovery-tools.ts`,
  `marketplace-guide-tools-repository.ts:42,55`, `marketplace-journey-tools-repository.ts:33,67`,
  `cart-checkout-tools-repository.ts:37,41,45`;
  automation handlers `services/automation-handlers/health-wellness-repository.ts:91`,
  `health-action-initiative-repository.ts:81`; `services/checkout/checkout-service-repository.ts:44`.
- `tenant_catalog_overrides`: foundation migration `20260416120000_vtid_02000_marketplace_foundation.sql`
  (bare `_select` RLS); not enforced anywhere (commerce arch §"Partner↔tenant relationship").
- `partner_tenant.tenant_id` written `caller.tenantId || 'platform'` at
  `services/gateway/src/services/partner-onboarding-service.ts:948`; onboarding routes `routes/partner-onboarding*.ts`.
- Referral/commission: `services/gateway/src/services/recommendation-commissions/credit-recommender.ts`
  (+ `referral-validation.ts`, `credit-recommender-repository.ts`); click attribution `routes/click-redirect.ts`.
- Resolver helpers (from mt-identity): `tenant_id_for_policies()`, `is_member()`.
- `platform_only_accounts` view — created by mt-community-isolation M2 (O5); referenced here, never created.
- Frontend: `vitana-v1/src/pages/Discover.tsx` (tab pill is the tab selector, not a scope); scope mode control is
  `MobileModePill`/`SplitBar` in the utility bar (SPOTLIGHT_RULES.md §D) — the Discover scope control is a THIRD,
  separate control. `useTenant` for tenant context; Commerce UX contract in `vitana-v1/CLAUDE.md`.

## Design per lane
### supplier-relationships-db (DB, vitana-platform)
- `supplier_tenant_relationships(id, supplier_id/org_id, tenant_id uuid REFERENCES tenants, status text CHECK IN
  ('proposed','active','declined','suspended'), vertical/scope, created_at, updated_at, decided_at)`; RLS: SELECT for
  tenant members via `is_member(tenant_id)`, ALL for `service_role`; migration default seeds existing network
  merchants `active` for Maxina only (D7). Not duplicated: references `partner_tenant`/supplier id (ALWAYS 9).
- `products.distribution text NOT NULL DEFAULT 'community' CHECK (distribution IN ('community','network'))` added
  expand/contract (add with default → existing rows `community` → drop default per §4.7).
- `partner_tenant.tenant_id` free text → real tenant UUID or NULL (platform): snapshot `bak_*` first, map only
  unambiguous rows, unresolvable → NULL.
- Referral attribution: a `buyer_tenant_id uuid` column on **`product_orders`** (the concrete commission-attribution
  row — verified: `credit-recommender-repository.ts:28 fetchProductOrderForCommission` selects
  `attribution_recommendation_id, merchant_id, product_id, user_id, click_id` from `product_orders`, and
  `checkout-service-repository.ts insertPendingOrders` writes it). The commission ledger `recommendation_commissions`
  already carries `recommender_user_id`, so no column is added there. The column is added DARK (nullable, expand-only,
  no default) and is READ only by lane `supplier-onboarding-communities` task S4 behind the mt flags —
  `supplier-onboarding-communities` already `depends_on supplier-relationships-db`. This is one logical change split
  across the two lanes per §4.7 (DB file here, consuming code there).
- Migrations 20261101120000–120300, each with rollback + `live-before.sql` + `post-apply-checks.sql`,
  `lock_timeout` + retries, a MIGRATION-QUEUE.md row at the WS11 position, drift-baseline entry removed after apply.

### discover-shared-predicate (CODE, vitana-platform)
- `services/gateway/src/services/discover/tenant-visibility.ts`: the single predicate (R1/R2) + the health-category
  trust-2 + DPA gate (R8). It serves TWO reader classes (verified against current code), because a tenant-visibility
  gate on a by-id fulfilment lookup would 404 an in-flight order instead of fixing discovery:
  - **discovery** readers (open feed/search/browse): `discover-feed-repository.ts:40`,
    `discover-search-repository.ts:29`, `discover-recommendations-repository.ts:23`,
    `shop-feed-repository.ts fetchRankedShopVideosPage` (the feed query, not the by-id one),
    `orb-tools/marketplace-discovery-tools.ts`, `marketplace-guide-tools-repository.ts:42,55`,
    `marketplace-journey-tools-repository.ts:33,67`, `automation-handlers/health-wellness-repository.ts:91`,
    `health-action-initiative-repository.ts:81`. These apply the FULL predicate (relationship + distribution scope +
    overrides hide + health gate).
  - **fulfilment** readers (by explicit product id — hydration/cart/checkout/reorder): confirmed in code as
    `shop-feed-repository.ts:32 fetchProductsByIds` (anchor + saved-products hydration),
    `orb-tools/cart-checkout-tools-repository.ts:36 fetchProductsByIds`,
    `services/checkout/checkout-service-repository.ts:42 fetchProductsByIds`. These resolve a KNOWN item by id and
    MUST NOT be filtered by relationship/distribution — otherwise a product a member saved or has in cart while the
    supplier was active (now suspended for the tenant) silently 404s mid-checkout. They may honour an explicit
    `tenant_catalog_overrides` hide only if product policy later wants it, but never relationship/distribution. The
    inventory lint requires each fulfilment reader to be annotated `// discover-inventory: fulfilment` (sibling of
    `shop-feed-repository.ts fetchProductsByIds` reorder-core's by-id reader, out of this spec's path set, carries
    the same annotation when it is next touched).
- `scripts/ci/discover-reader-inventory.*`: GENERATED list of `products`/`merchants` readers tagging each as
  `discovery` or `fulfilment`; a build-failing lint asserts every `discovery` reader goes through the predicate and
  every `fulfilment` reader is annotated and NOT relationship/distribution-filtered (R3), and the lineage guard
  fails on a health_* read in EITHER class (R4), modelled on commerce arch §7.2 ranking guard.
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
1. Migrations apply strictly in `MIGRATION-QUEUE.md` order, one RUN-MIGRATION dispatch per file, by Claude only, with
   read-only pre/post checks; new multi-tenant migrations take the next version in the lane range and add their queue
   row in the same PR; a not-yet-live table is added to `scripts/ci/migration-drift-baseline.json` and removed after
   apply.
2. Dark by default (`MT_RESOLUTION_V2`, `tenant_settings.feature_flags.mt.*`); no exception in this spec.
3. ONE shared Discover predicate — never re-implement per surface; new readers register in the generated inventory
   tagged `discovery` (full predicate) or `fulfilment` (by-explicit-id, unfiltered, annotated). Never gate a
   by-id fulfilment lookup by relationship/distribution.
4. Lineage guard: no `products`/`merchants` reader reads `health_*`/`wearable_*`/`biomarker_*`/`lab_*`/`vitana_index_*`.
5. `platform_only_accounts` is created by mt-community-isolation M2 (O5); this spec references it only.
6. Network groups and messenger scope live in mt-network; this spec owns only Discover + offering distribution.
7. Production read-only for every session and test (rules 31–32, 48); the executor never writes to a live system
   (collaboration §7a). Supplier onboarding writes are never run against a live system by the executor.
8. Test/service/platform-only accounts never surfaced (rules 43–45); i18n DE-first du-form; RTL via logical
   properties; Spotlight design contract; WCAG 2.2 AA; Commerce UX contract on every supplier screen.
