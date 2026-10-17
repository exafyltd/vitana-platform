# Tasks — mt-discover (Commerce & Discover × tenancy)

Authoritative plan: `plan.md` (this folder). Design: `design.md`. Lane files: `lanes/`.
VTID: allocated by PLAN-SPAR after approval. DB applied by Claude via RUN-MIGRATION.

<!-- lane: supplier-relationships-db -->
## supplier-relationships-db — tenant↔supplier + offering distribution (repo vitana-platform)

Allowed paths:
`supabase/migrations/20261101120000_*_supplier_tenant_relationships.sql`,
`supabase/migrations/20261101120100_*_products_distribution.sql`,
`supabase/migrations/20261101120200_*_partner_tenant_backfill.sql`,
`supabase/migrations/20261101120300_*_referral_tenant_attribution.sql`,
`docs/multitenancy/MIGRATION-QUEUE.md`,
`scripts/ci/migration-drift-baseline.json`,
`services/gateway/test/vtid-*-supplier-tenant-relationships.test.ts`

- [ ] D1 `supplier_tenant_relationships` table + RLS (`is_member` read, service-role write) + default-active-for-Maxina
      seed for existing network merchants (D7); expand only.
- [ ] D2 `products.distribution` column (expand/contract: DEFAULT 'community' → backfill → drop default), CHECK.
- [ ] D3 `partner_tenant.tenant_id` free-text → UUID/NULL backfill; snapshot `bak_*` first; unresolvable → NULL.
- [ ] D4 `ALTER TABLE product_orders ADD COLUMN buyer_tenant_id uuid` (nullable, expand-only, no default) — the
      commission-attribution row (`credit-recommender-repository.ts:28`); added dark, read by S4 only.
- [ ] D5 rollback files, `live-before.sql`/`post-apply-checks.sql`, `lock_timeout`+retries, MIGRATION-QUEUE rows at
      the WS11 position (depends on A-M1 `is_default`/`is_platform` + mt-identity classification), drift-baseline add.
- [ ] D6 pgTAP: RLS (T_B member reads 0 T_A rows), `distribution` CHECK, Maxina-only seed.

Acceptance: pgTAP green; migrations lint clean; queue rows + rollback present; drift-baseline updated; adds its own
`docs/validation/<vtid>/`. Executor never applies the migration — Claude does via RUN-MIGRATION after merge.

<!-- lane: discover-shared-predicate -->
## discover-shared-predicate — one shared Discover predicate + inventory + lineage guard (repo vitana-platform)

Allowed paths:
`services/gateway/src/services/discover/**`,
`services/gateway/src/routes/discover-feed-repository.ts`,
`services/gateway/src/routes/discover-search-repository.ts`,
`services/gateway/src/routes/discover-recommendations-repository.ts`,
`services/gateway/src/routes/shop-feed-repository.ts`,
`services/gateway/src/services/orb-tools/marketplace-discovery-tools.ts`,
`services/gateway/src/services/orb-tools/marketplace-guide-tools-repository.ts`,
`services/gateway/src/services/orb-tools/marketplace-journey-tools-repository.ts`,
`services/gateway/src/services/orb-tools/cart-checkout-tools-repository.ts`,
`services/gateway/src/services/automation-handlers/health-wellness-repository.ts`,
`services/gateway/src/services/automation-handlers/health-action-initiative-repository.ts`,
`services/gateway/src/services/checkout/checkout-service-repository.ts`,
`scripts/ci/discover-reader-inventory.mjs`,
`services/gateway/test/vtid-*-discover-tenant-visibility.test.ts`,
`services/gateway/test/vtid-*-discover-lineage-guard.test.ts`,
`services/gateway/test/vtid-*-discover-isolation.test.ts`

- [ ] P1 `services/gateway/src/services/discover/tenant-visibility.ts`: the v1 predicate (R1/R2) + health-category
      trust-2+DPA gate (R8); scope term (`distribution`), overrides hide in BOTH modes.
- [ ] P2 Route every DISCOVERY reader through the predicate: the open-query readers plus the by-id discovery
      initiator `discover-recommendations-repository.ts:23` (`fetchActiveProductForRecommendation`). Leave the
      FULFILMENT by-id hydration readers unfiltered + annotated `// discover-inventory: fulfilment`:
      `shop-feed-repository.ts:32`, `cart-checkout-tools-repository.ts:36`, `checkout-service-repository.ts:42`
      (`fetchProductsByIds`) and `health-action-initiative-repository.ts:81` (`fetchProductById`). Do NOT touch
      `shop-feed-repository.ts:43 fetchRankedShopVideosPage` (reads `shop_videos`, not a products reader). No
      behaviour change while flags off; a saved/in-flight order is never 404'd.
- [ ] P3 `scripts/ci/discover-reader-inventory.mjs`: GENERATED inventory tagging each `products`/`merchants` reader
      `discovery|fulfilment` + build-failing lint (R3: discovery goes through the predicate, fulfilment is annotated
      + unfiltered) + PER-QUERY lineage guard (R4: fails only when the same query that reads `products`/`merchants`
      also reads health_*/wearable_*/biomarker_*/lab_*/vitana_index_*; must NOT flag a sibling function in a mixed
      file — tolerate `health-wellness-repository.ts` and `health-action-initiative-repository.ts`).
- [ ] P4 Dark behind `MT_RESOLUTION_V2` + `mt.discover_tenant_gate` / `mt.network_enabled`.
- [ ] P5 Vitest: predicate (community/network, overrides, relationship active/inactive, health gate); inventory lint
      (a bypassing discovery reader fails; an unannotated fulfilment reader fails); per-query lineage guard (fails on
      a health_* read in the SAME query as a products read; PASSES a mixed file whose health read is a sibling
      function); isolation suite (supplier active only in T_A absent in T_B incl. ORB; network offering in both;
      fulfilment-by-id read of a known T_A product still resolves when the supplier is suspended for the tenant).
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
- [ ] S4 Referral attribution carries the buyer's tenant; recommender earnings follow recommender's tenant (R7, D26);
      no ranking influence.
- [ ] S5 Dark behind the mt flags.
- [ ] S6 Vitest: "which communities" creates `proposed` rows; accept/decline flips state; attribution carries buyer
      tenant; commerce signup no longer hardcodes Maxina.

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
