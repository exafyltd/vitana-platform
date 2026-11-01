# Tasks — mt-discover (Commerce & Discover × tenancy)

Authoritative plan: `plan.md` (this folder). Design: `design.md`. Lane files: `lanes/`.
VTID: allocated by PLAN-SPAR after approval. DB applied by Kiro on the owner's approval (§7d).

<!-- lane: supplier-relationships-db -->
## supplier-relationships-db — tenant↔supplier + offering distribution (repo vitana-platform)

Allowed paths:
`supabase/migrations/20261102120000_*_supplier_tenant_relationships.sql`,
`supabase/migrations/20261102120100_*_products_distribution.sql`,
`supabase/migrations/20261102120200_*_partner_tenant_backfill.sql`,
`supabase/migrations/20261102120300_*_products_merchants_tenant_rls.sql`,
`docs/multitenancy/MIGRATION-QUEUE.md`,
`scripts/ci/migration-drift-baseline.json`,
`services/gateway/test/vtid-*-supplier-tenant-relationships.test.ts`

- [ ] D1 `supplier_tenant_relationships` table + RLS (member read via inline `user_tenants` EXISTS — no mt-identity
      helper; service-role write) + default-active-for-Maxina
      seed for existing network merchants (D7); expand only.
- [ ] D2 `products.distribution` column (expand/contract: DEFAULT 'community' → backfill → drop default), CHECK.
- [ ] D3 `partner_tenant.tenant_id` free-text → UUID/NULL backfill; snapshot `bak_*` first; unresolvable → NULL.
- [ ] D4 Replace `products_select`/`merchants_select` RLS (`...foundation.sql:729/:735`, today `is_active = TRUE`
      only) with tenant-scoped policies (`is_active AND (distribution='network' OR EXISTS active
      supplier_tenant_relationships for current_tenant_id())`), guarded by a new `discover_tenant_gate_enabled()`
      (STABLE SECURITY DEFINER, `SET search_path = public, pg_catalog`, false when tenant NULL / no row) so gate off ⇒
      identical to `is_active` only, gate on + NULL tenant ⇒ network rows only (R1-F2, R3-F2); no `is_member()`. NO
      `product_orders` column — D26 reuses the existing `product_orders.tenant_id` (R1-F3); `credit-recommender`
      selecting it is the `supplier-onboarding-communities` S4 code change, not a DB task.
- [ ] D5 rollback files, `live-before.sql`/`post-apply-checks.sql`, `lock_timeout`+retries, MIGRATION-QUEUE rows at
      the WS11 position (depends on A-M1 `is_default`/`is_platform` + mt-identity-r2 classification), drift-baseline add.
- [ ] D6 pgTAP: `supplier_tenant_relationships` RLS (T_B member reads 0 T_A rows), `distribution` CHECK, Maxina-only
      seed, and the new tenant-scoped `products`/`merchants` RLS (T_B user-JWT read sees 0 T_A-only supplier rows; a
      `network` product visible to both; flag off → Maxina sees all) (R1-F2).

Acceptance: pgTAP green; migrations lint clean; queue rows + rollback present; drift-baseline updated; adds its own
`docs/validation/<vtid>/`. Kiro applies the migration via RUN-MIGRATION, only on the owner's approval of the files and the target database (§7d), after merge.

<!-- lane: discover-shared-predicate -->
## discover-shared-predicate — one shared Discover predicate + inventory + lineage guard (repo vitana-platform)

Allowed paths:
`services/gateway/src/services/discover/**`,
`services/gateway/src/routes/discover-feed-repository.ts`,
`services/gateway/src/routes/discover-search-repository.ts`,
`services/gateway/src/routes/discover-recommendations-repository.ts`,
`services/gateway/src/routes/shop-feed-repository.ts`,
`services/gateway/src/routes/universal-cart-context-repository.ts`,
`services/gateway/src/routes/click-redirect-repository.ts`,
`services/gateway/src/routes/admin-marketplace-repository.ts`,
`services/gateway/src/routes/catalog-ingest-repository.ts`,
`services/gateway/src/routes/vcaop-portal-my-products.ts`,
`services/gateway/src/routes/partner-onboarding-catalogue.ts`,
`services/gateway/src/routes/partner-onboarding.ts`,
`services/gateway/src/services/orb-tools/marketplace-discovery-tools.ts`,
`services/gateway/src/services/orb-tools/marketplace-*-repository.ts`,
`services/gateway/src/services/orb-tools/cart-checkout-tools-repository.ts`,
`services/gateway/src/services/automation-handlers/health-wellness-repository.ts`,
`services/gateway/src/services/automation-handlers/health-action-initiative-repository.ts`,
`services/gateway/src/services/checkout/checkout-service-repository.ts`,
`services/gateway/src/services/gemini-operator-repository.ts`,
`services/gateway/src/services/intent-matcher-repository.ts`,
`services/gateway/src/services/partner-onboarding-service.ts`,
`services/gateway/src/services/partner-review.ts`,
`services/gateway/src/services/partner-setup.ts`,
`services/gateway/src/services/shopify-sync-repository.ts`,
`services/gateway/src/services/marketplace-sync/shared-repository.ts`,
`services/gateway/src/services/marketplace-sync/amazon-sync-repository.ts`,
`services/gateway/src/services/admin-scanners/marketplace-repository.ts`,
`services/gateway/src/services/recommendation-engine/analyzers/marketplace-analyzer-repository.ts`,
`services/gateway/src/services/recommendation-commissions/credit-recommender-repository.ts`,
`services/gateway/src/services/shopping-agent/agent-core-repository.ts`,
`services/gateway/src/services/shopping-agent/reorder-core-repository.ts`,
`scripts/ci/discover-reader-inventory.mjs`,
`services/gateway/test/vtid-*-discover-tenant-visibility.test.ts`,
`services/gateway/test/vtid-*-discover-lineage-guard.test.ts`,
`services/gateway/test/vtid-*-discover-isolation.test.ts`

- [ ] P1 `services/gateway/src/services/discover/tenant-visibility.ts`: the v1 predicate (R1/R2) + health-category
      trust-2+DPA gate (R8); scope term (`distribution`), overrides hide in BOTH modes.
- [ ] P2 Route every DISCOVERY reader through the predicate and annotate every FULFILMENT and ADMIN/INGESTION reader.
      The lane owns the FULL swept set (2026-10-17), classified:
      **DISCOVERY (full predicate):** `discover-feed-repository.ts:40`, `discover-search-repository.ts:29,:37`,
      `routes/discover-recommendations-repository.ts:22-23` (by-id discovery initiator — a T_B recommender cannot mint a
      share link for a T_A-only product),
      `orb-tools/marketplace-discovery-tools-repository.ts` (searchProducts :34, searchProductByTitleTop1 :47,
      fetchProductsByCategory :51, fetchDealsProducts :68, fetchProductById :43),
      `orb-tools/marketplace-va-shared-repository.ts` (fetchProductByFuzzyTitle :44, fetchProductById :35),
      `orb-tools/marketplace-guide-tools-repository.ts:42,:55`,
      `orb-tools/marketplace-journey-tools-repository.ts:33,:67`,
      `automation-handlers/health-wellness-repository.ts:90-92` (thread `ctx.tenantId`, `health-wellness.ts:261`),
      `gemini-operator-repository.ts` (operator search :39, fetchDiscoverFeed :62),
      `intent-matcher-repository.ts:32`,
      `recommendation-engine/analyzers/marketplace-analyzer-repository.ts:40`,
      `shopping-agent/agent-core-repository.ts:27`, and the **video-anchor call site** of
      `shop-feed-repository.ts:32 fetchProductsByIds` (R1-F1: the module comment at :31 marks it reused for BOTH
      anchor-hydration AND saved-products hydration — the anchor path is a discovery surface, split into its own
      function/annotated call site and routed through the predicate).
      **FULFILMENT (by-id hydration, unfiltered + `// discover-inventory: fulfilment`):** the **saved-products call
      site** of `shop-feed-repository.ts:32` (the other half of the R1-F1 split),
      `cart-checkout-tools-repository.ts:36,:41` (not :45 searchActiveProductsByTitle — that is DISCOVERY),
      `checkout-service-repository.ts:42`, `health-action-initiative-repository.ts:81`,
      `universal-cart-context-repository.ts:45`, `shopping-agent/reorder-core-repository.ts:24`,
      `click-redirect-repository.ts:20` (redirect of a chosen product),
      `orb-tools/marketplace-journey-tools-repository.ts:51,:55`,
      `orb-tools/marketplace-discovery-tools-repository.ts` (fetchProductTitlesByIds, fetchProductTitleById),
      `recommendation-commissions/credit-recommender-repository.ts:114` (fetchMerchantCommissionEligibility —
      by-explicit-merchant_id commission read on an already-placed order; serves no admin/member surface).
      **ADMIN/INGESTION (unfiltered, admin-guarded + `// discover-inventory: admin`):** `admin-marketplace-repository.ts`,
      `catalog-ingest-repository.ts`, `vcaop-portal-my-products.ts`, `partner-onboarding-catalogue.ts`,
      `partner-onboarding.ts`, `partner-onboarding-service.ts`, `partner-review.ts`, `partner-setup.ts`,
      `shopify-sync-repository.ts`, `marketplace-sync/shared-repository.ts`, `marketplace-sync/amazon-sync-repository.ts`,
      `admin-scanners/marketplace-repository.ts`.
      Do NOT touch `shop-feed-repository.ts:43 fetchRankedShopVideosPage` (reads `shop_videos`, not a products reader).
      No behaviour change while flags off; a saved/in-flight order is never 404'd.
- [ ] P3 `scripts/ci/discover-reader-inventory.mjs`: GENERATED inventory tagging each `products`/`merchants` reader
      `discovery|fulfilment|admin` + build-failing lint (R3: discovery goes through the predicate; fulfilment is
      annotated `// discover-inventory: fulfilment` + unfiltered; admin/ingestion/supplier-portal is annotated
      `// discover-inventory: admin` + unfiltered + admin-guarded; anything unclassified fails) + PER-QUERY lineage
      guard (R4: fails only when the same query that reads `products`/`merchants` also reads
      health_*/wearable_*/biomarker_*/lab_*/vitana_index_*; must NOT flag a sibling function in a mixed file —
      tolerate `health-wellness-repository.ts` and `health-action-initiative-repository.ts`).
- [ ] P4 Dark behind `MT_RESOLUTION_V2` + `mt.discover_tenant_gate` / `mt.network_enabled`.
- [ ] P5 Vitest: predicate (community/network, overrides, relationship active/inactive, health gate); inventory lint
      (a bypassing discovery reader fails; an unannotated fulfilment reader fails; an unclassified admin/ingestion
      reader fails); per-query lineage guard (fails on
      a health_* read in the SAME query as a products read; PASSES a mixed file whose health read is a sibling
      function); isolation suite (supplier active only in T_A absent in T_B incl. ORB **and absent via a shop-video
      anchor** — R1-F1; network offering in both; a saved-products/cart/checkout fulfilment-by-id read of a known
      T_A product still resolves when the supplier is suspended for the tenant).
- [ ] P6 ORB dispatcher tests on Nova + Vertex Serbian bridge if the ORB product/cart tool dispatch changes (42h).

Acceptance: full gateway Vitest/Jest green; inventory lint + lineage guard red when a reader bypasses/reads health;
`npm run test:support` + `npm run test:operator` green if touched; adds its own `docs/validation/<vtid>/`.

<!-- lane: supplier-onboarding-communities -->
## supplier-onboarding-communities — "which communities" + platform/commerce path + attribution (repo vitana-platform)

Allowed paths:
`services/gateway/src/services/partner-onboarding-service.ts`,
`services/gateway/src/routes/partner-onboarding.ts`,
`services/gateway/src/routes/partner-onboarding-catalogue.ts`,
`services/gateway/src/services/recommendation-commissions/credit-recommender.ts`,
`services/gateway/src/services/recommendation-commissions/credit-recommender-repository.ts`,
`services/gateway/src/routes/click-redirect.ts`,
`services/gateway/test/vtid-*-supplier-onboarding-communities.test.ts`,
`services/gateway/test/vtid-*-referral-tenant-attribution.test.ts`

- [ ] S1 "Which communities" step (service + onboarding routes + Commerce MCP + voice path) → `proposed` relationships.
- [ ] S2 Tenant accept/decline API (`proposed→active|declined`).
- [ ] S3 Platform tenant + `signup_intent='commerce'` path: drop hardcoded Maxina; `signup_intent` routes only (R6).
- [ ] S4 Referral attribution reads the buyer's tenant from the EXISTING, NULLABLE `product_orders.tenant_id`
      (VTID-04740 `20260929120200…sql:12`; extend `fetchProductOrderForCommission`, `credit-recommender-repository.ts:26-32`,
      to select it; no new column): `buyer_tenant_source` = `'order'` (non-NULL) or `'anonymous_buyer'` (NULL, kept
      NULL — never the recommender's/platform/default tenant); `recommender_tenant_id` = `resolvePrimaryTenant(
      recommender_user_id)` (R7, D26); carried on the commission OASIS events + credit result (ledger columns are M3);
      no ranking influence.
- [ ] S5 Dark behind the mt flags.
- [ ] S6 Vitest: "which communities" creates `proposed` rows; accept/decline flips state; attribution carries buyer
      tenant (`'order'`) and an anonymous order is labelled `'anonymous_buyer'` with NULL tenant; commerce signup no longer hardcodes Maxina.

Acceptance: full gateway Vitest/Jest green; `npm run test:support`/`npm run test:operator` green if touched; executor
never calls a provisioning/onboarding write endpoint against a live system; adds its own `docs/validation/<vtid>/`.

<!-- lane: discover-mode-ui -->
## discover-mode-ui — Discover Community/Network control + supplier UI (repo vitana-v1)

Allowed paths:
`src/pages/Discover.tsx`,
`src/components/discover/**`,
`src/components/commerce/**`,
`src/lib/discover-scope.ts`,
`src/i18n/de/discover.json`,
`src/i18n/en/discover.json`,
`src/i18n/de/commerce.json`,
`src/i18n/en/commerce.json`,
`src/components/discover/discover-scope.test.tsx`,
`tests/e2e/staging/vtid-*-discover-scope.staging.spec.ts`,
`docs/SCREEN_INVENTORY.md`,
`i18n-source-stamps/**`

- [ ] U1 Separate Discover Community/Network scope control on the Discover screen (not the tab pill, not
      `MobileModePill`), default Community, remembered per surface (`src/lib/discover-scope.ts`) (R9).
- [ ] U2 Supplier "which communities" + tenant accept/decline UI per the Commerce UX contract (R11): AI-led, one
      dominant action, no internal concepts; PR "UX acceptance" section.
- [ ] U3 Spotlight (`ScreenFrame`/`VCard`, tokens, logical start/end, skeletons); i18n DE-first du-form; RTL.
- [ ] U4 Dark behind `mt.network_enabled`.
- [ ] U5 Vitest: control default Community + per-surface memory + separate from tab pill; supplier UI validation; no
      write request on render. `npm run i18n:inventory`.
- [ ] U6 Staging spec (read-only): control renders + defaults to Community for the test user; network guard aborts
      any non-GET.

Acceptance: full `npx vitest run` green; ESLint i18n + design clean on new files; `npm test` (nav/manifest/parity
unaffected — no new route); PR gate scope/sparring/weakening green; adds its own `docs/validation/<vtid>/`.

## Escalation carry-over (from `mt-discover`, session `b452b935`)
The last round ended with `partner_output_invalid` and rendered no findings, so there is nothing to answer for
R4-N1/R4-N2. R3-F1..F3 were accepted in `s2-responses-2` but no partner acknowledged them. They are carried here with
an acceptance each, answered in `plan.md` "Re-plan answers".
- R3-F1 [major]: health-aware product recommendations read `products` without the Discover predicate
  (`health-wellness-repository.ts:90-91`).
  Lane: `discover-shared-predicate`.
  Acceptance: the `runHealthAwareProductRecs` products query carries the predicate for `ctx.tenantId` (mocked
  client). It is red on `origin/main`.
- R3-F2 [major]: `is_member()`, `tenant_id_for_policies()` and `discover_tenant_gate_enabled()` do not exist in any
  migration.
  Lane: `supplier-relationships-db`.
  Acceptance: pgTAP `has_function('public','discover_tenant_gate_enabled')`. With the gate off, the result equals the
  `is_active`-only result. There is no dependency on `mt-identity-r2`. It is red on `origin/main`.
- R3-F3 [minor]: `discover-recommendations-repository.ts:22-23` reads a product by id + `is_active` only.
  Lane: `discover-shared-predicate`.
  Acceptance: a T_B recommender minting for a T_A-only product gets 404. It is red on `origin/main`.

