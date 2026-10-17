# Internal review — mt-discover (NN=12), pre-CI, independent

Reviewer: independent internal sparring (fresh read, no planner context). Read in full: BATCH-BRIEF.md,
CROSS-SPEC-DECISIONS.md, and every file under `.kiro/specs/mt-discover/` (plan.md, requirements.md, design.md,
tasks.md, handoff.md, lanes/*.md). Every premise re-verified against current platform code (read-only); the frontend
repo (vitana-v1) was consulted for the UI lane. Validators run.

## Method
- queue.mjs validators (`parseFrontMatter`, `validatePlan`, `validateLane`) run on handoff.md and all four lane
  files with correct `(fm, slug[, lane, laneIds])` signatures — see "Validators" below.
- Every file:line premise in plan.md grepped/read in `C:\Users\dstev\vitana-platform-1`.
- A full `from('products')|from('merchants')` sweep of `services/gateway/src/**` to test the central claim that the
  reader inventory is complete / the lane paths cover every file the tasks must change.

## Validators (queue.mjs) — PASS
Run against `.kiro/specs/mt-discover`:
```
handoff.md                     => []
discover-mode-ui               => []
discover-shared-predicate      => []
supplier-onboarding-communities=> []
supplier-relationships-db      => []
```
Zero validator errors. Front matter, states (`ready`/`drafted`), `next_actor`, executor/seat/reviewer_seat (every
`reviewer_seat` differs from `seat`), paths present, depends_on all name lanes of this spec, no kiro lane reaches a
governance path. No HIGH from the validators.

## Verified premises (against current code)
1. **`supplier_tenant_relationships` absent** — a repo-wide grep returns matches only in `docs/MULTI-TENANT-PLAN.md`
   (which itself says "designed, not yet created — verified absent 2026-10-10"); zero in `supabase/migrations/**` and
   `services/gateway/src/**`. Plan Problem 1 correct.
2. **`products.distribution` absent** — no `distribution` match in the marketplace migrations. Plan Problem 4 correct.
3. **`tenant_catalog_overrides` exists, bare `_select` RLS, unenforced** — `20260416120000_vtid_02000_marketplace_foundation.sql:326`
   creates the table; `:809-811` the `tenant_catalog_overrides_select` policy `tenant_id = public.current_tenant_id()`;
   `:857` `GRANT SELECT ... TO authenticated`. Plan Problem 3 correct.
4. **`partner_tenant.tenant_id = caller.tenantId || 'platform'`** — `partner-onboarding-service.ts:948`
   (`tenant_id: caller.tenantId || 'platform'`). Plan Problem 5 correct.
5. **Attribution row is `product_orders`** — `credit-recommender-repository.ts:28 fetchProductOrderForCommission`
   selects `id, state, commission_cents, currency, attribution_recommendation_id, merchant_id, product_id, user_id,
   click_id` from `product_orders`. Design/plan D4 (`ADD COLUMN buyer_tenant_id` on `product_orders`) targets the
   correct table; `recommendation_commissions` carrying `recommender_user_id` is consistent with the design note.
6. **Discovery open-query readers** — `discover-feed-repository.ts:40 buildCandidateProductsFeedQuery`
   (`from('products').eq('is_active',true).eq('availability','in_stock')`); `discover-search-repository.ts:29
   buildProductSearchQuery` (`is_active`). Both products readers, filter only is_active/availability. Correct.
7. **By-id discovery initiator** — `discover-recommendations-repository.ts:23 fetchActiveProductForRecommendation`
   (`from('products').eq('id',…).eq('is_active',true)`). Correctly classified DISCOVERY.
8. **Fulfilment by-id readers** — `shop-feed-repository.ts:32 fetchProductsByIds`,
   `cart-checkout-tools-repository.ts:36 fetchProductsByIds`, `checkout-service-repository.ts:42 fetchProductsByIds`
   all read `products` by `.in('id',…)`. Correctly classified FULFILMENT. CROSS-SPEC "reader inventory corrections"
   confirmed.
9. **`shop-feed-repository.ts:43 fetchRankedShopVideosPage` reads `shop_videos` only** — confirmed (select carries no
   product id). Correctly excluded from the predicate's scope. CROSS-SPEC correction applied.
10. **The two mixed-module files, exactly as claimed** — `health-wellness-repository.ts`: products at `:91`
    (`fetchActiveProductsByTopicKeys`), health at `:28,:32 (lab_reports)`, `:44,:50,:55 (vitana_index_scores)`,
    `:68 (biomarker_results)`. `health-action-initiative-repository.ts`: products at `:81`
    (`fetchProductById`), health at `:26,:30 (lab_tests/lab_test_orders)`, `:54 (vitana_index_scores)`,
    `:60,:64 (wearable_workouts)`. This confirms Problem 10 and the per-query-lineage-guard rationale: a per-module
    guard would RED-flag these existing unrelated siblings. The CROSS-SPEC "lineage guard is per-QUERY" ruling is
    correctly applied in requirements R4, design Rule 4, plan Fix/Risks, tasks P3/P5.

## Cross-spec rulings — CONFIRMED
- **O5 (`platform_only_accounts`).** plan.md "Out of scope" says the view is created by mt-community-isolation M2 and
  "this spec only references it"; design.md "What exists" and Rule 5 same; requirements Program-position and handoff
  log same. No stale Risks line about creating it (the Risks section does not mention it). CONFIRMED exactly as O5
  requires — references M2, does NOT create it, no stale Risks line.
- **Network groups live only in mt-network.** plan "Out of scope" and "Depends on", design Rule 6, requirements
  Program-position all state mt-discover owns ONLY Discover + offering distribution. CONFIRMED.
- **CROSS-SPEC premise corrections for mt-discover both applied:** lineage guard per-query (finding 10 above);
  reader-inventory corrections (`fetchRankedShopVideosPage` removed; `discover-recommendations-repository.ts:23`
  classified as the by-id discovery initiator). CONFIRMED.

## DB/code split, deps, migration safety, rollout — sound
- **DB/code split (§4.7).** `supplier-relationships-db` is DB-only (migrations + MIGRATION-QUEUE + drift-baseline +
  one pgTAP test file); the consuming code is in separate lanes. `product_orders.buyer_tenant_id` is added dark in the
  DB lane and read only by `supplier-onboarding-communities` S4 — one logical change split across two lanes, correctly
  described in design.
- **depends_on DAG.** `supplier-relationships-db []` → `discover-shared-predicate [supplier-relationships-db]` and
  `supplier-onboarding-communities [supplier-relationships-db]` → `discover-mode-ui [discover-shared-predicate]`.
  Acyclic, every dep is a lane of this spec (validators confirm), ordering matches the data dependencies.
- **Migration safety.** Four files in range `20261101120000–120300`, each with a rollback file, `live-before.sql` /
  `post-apply-checks.sql`, `lock_timeout` + retries, a MIGRATION-QUEUE row at the WS11 position. `products.distribution`
  is expand/contract (add w/ DEFAULT → backfill → drop default). `product_orders.buyer_tenant_id` nullable expand-only.
  `partner_tenant.tenant_id` backfill snapshots `bak_*` first, unresolvable → NULL. The A-M1 dependency
  (`tenants.is_default`/`is_platform`, `20261014000100`) is a real row in MIGRATION-QUEUE.md (#6 cites it). Not-yet-live
  tables added to `scripts/ci/migration-drift-baseline.json` (file exists) and removed after apply. DB applied by
  Claude via RUN-MIGRATION — executor never writes a live system. All consistent with the standing rules.
- **Dark by default.** `MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.discover_tenant_gate` /
  `mt.network_enabled` throughout; "no behaviour change while flags off, Maxina Discover unchanged (D7)". Correct.
- **Standing rules.** Rules 31/31b/48 (production read-only, staging read-only, no second tenant on staging — writes
  proven by Vitest/pgTAP) stated in plan Staging/Tests and every lane body. Rules 43–45 (test/service/platform-only
  accounts never surfaced) carried via the `platform_only_accounts` reference. 42c/42e (`test:support`/`test:operator`
  when touched) and 42h (ORB Nova + Vertex Serbian bridge dispatcher tests if ORB tool dispatch changes) present in
  tasks P5/P6 and plan Tests. i18n DE-first du-form + RTL, Spotlight, Commerce UX contract, "no new route → no
  nav/manifest/parity change" all present in the UI lane (U2/U3) and design. Bedrock-only / no-Google: not applicable
  (no LLM routing change); nothing in the spec introduces a Google call. All satisfied.
- **No duplication of DONE work.** Builds on VTID-05149/05150/05151 (M0, in production) and VTID-04732 (design only);
  does not re-plan them. No overlap with another mt-* spec's owned surface (network/messenger → mt-network;
  `platform_only_accounts` view → mt-community-isolation).

## Findings

### HIGH-1 — The `products`/`merchants` reader inventory and the lane `paths` are incomplete; the generated build-failing lint will force edits to files outside `discover-shared-predicate`'s declared paths, which the Lane-scope CI check will then reject.
A full `from('products')|from('merchants')` sweep of `services/gateway/src/**` finds discovery-shaped `products`
readers that the plan's Problem 2 / design readers-list does not enumerate AND that the lane's `paths` do not cover:

- **`services/gateway/src/services/orb-tools/marketplace-discovery-tools-repository.ts`** — the actual
  `.from('products')` discovery queries (`:34` search, `:47` by-title-top1, `:51` by-category, `:68` deals,
  `:43` by-id). The lane paths list only `marketplace-discovery-tools.ts` (the caller, which just does
  `import * as repo from './marketplace-discovery-tools-repository'` at `:83`). The queries that must be routed
  through the predicate live in the `-repository` file, which is **not** in `paths`.
- **`services/gateway/src/services/orb-tools/marketplace-va-shared-repository.ts`** — `fetchProductByFuzzyTitle`
  (`:44`, open `is_active` search = DISCOVERY by the plan's own rule) and `fetchProductById` (`:35`, by-id). Live
  module (imported by `marketplace-va-shared.ts:29`). Named nowhere in the spec and in no lane's `paths`.
- **`services/gateway/src/routes/click-redirect-repository.ts`** — `fetchActiveProductForRedirect` (`:20`, by-id,
  fulfilment-shaped; called from `click-redirect.ts:286`). The onboarding lane lists `routes/click-redirect.ts` but
  not this `-repository` file; the predicate lane lists neither.

The plan's stated mitigation — "the inventory is GENERATED, not a hand-list; every new reader must register; the lint
is build-failing" — is exactly what turns this into a HIGH rather than a nit. A build-failing generated inventory
means these readers CANNOT be left alone: each must either be wired through the predicate (discovery) or be annotated
`// discover-inventory: fulfilment`. That is an edit to each file above. But `discover-shared-predicate`'s `paths` do
not include them, so the PR-GATE **Lane scope** check (`queue.mjs scope-check`, collaboration §3a/§9) will fail the
PR the moment the executor touches `marketplace-discovery-tools-repository.ts`, `marketplace-va-shared-repository.ts`
or `click-redirect-repository.ts`. The lane is unbuildable as scoped: either the lint stays red (discovery readers
bypass the predicate) or Lane scope goes red (editing files outside paths). The plan already did the correct
`-repository` split for `shop-feed-repository.ts`; it was simply not carried through to the orb-tools / va-shared /
click-redirect clusters.
FIX: add the missing reader files to `discover-shared-predicate`'s `paths` (lane front matter) and to the
`discover-shared-predicate` "Allowed paths:" block in tasks.md — at minimum
`services/gateway/src/services/orb-tools/marketplace-discovery-tools-repository.ts`,
`services/gateway/src/services/orb-tools/marketplace-va-shared-repository.ts`, and
`services/gateway/src/routes/click-redirect-repository.ts` (the last may instead be annotated-only, but it is still an
edit and still needs to be in some lane's paths). Prefer a glob that captures the cluster, e.g.
`services/gateway/src/services/orb-tools/marketplace-*-repository.ts`, so a sibling reader added later does not
reproduce this gap. Update design.md "What exists" and plan Problem 2 to list these readers with their verified
file:line and discovery/fulfilment class, so the inventory the lint generates matches the plan of record. Also replace
the design/plan reference to `marketplace-discovery-tools.ts (search/browse)` with the `-repository` file where the
queries actually are.

### MEDIUM-1 — `admin-marketplace-repository.ts` reads `products`/`merchants` but the plan never classifies it; the generated inventory will flag it and there is no stated rule for admin readers.
`services/gateway/src/routes/admin-marketplace-repository.ts` reads `products` (`:28,:30,:83,:106`) and `merchants`
(`:27,:54`) for admin marketplace stats/listing. These are not member-facing discovery and should not be
relationship/distribution-gated, but the plan's inventory rule only has two buckets (discovery / fulfilment) and names
neither admin readers nor an "admin/ingestion, out of inventory scope" class. When the generated inventory runs, these
readers (and the ingestion readers in `catalog-ingest-repository.ts`, `partner-onboarding-catalogue.ts`,
`vcaop-portal-my-products.ts`) will be picked up with no defined disposition, so either the lint fails on them or the
executor must improvise a classification the spec did not sanction.
FIX: add an explicit third disposition to R3 / design Rule 3 and the inventory generator spec: admin/ingestion/
supplier-portal `products`/`merchants` readers (writes and admin-scope reads, e.g. `admin-marketplace-repository.ts`,
`catalog-ingest-repository.ts`, `partner-onboarding-catalogue.ts`, `vcaop-portal-my-products.ts`) are out of the
member Discover inventory's scope and are either excluded by path or annotated (e.g. `// discover-inventory: admin`),
and state the one-line rule that distinguishes them from member discovery (served to an admin/supplier surface, not a
member Discover/ORB surface). Name the files so the inventory generator and its test are deterministic.

### NIT-1 — plan.md body length is at/over the soft bound.
handoff.md log records the plan body at "~15.3k chars (within ~15k soft bound)"; BATCH-BRIEF says `<= ~15,000`.
It is a soft bound and the overflow is small, so this does not block, but the HIGH-1 additions will push it further.
FIX: when applying HIGH-1, tighten prose (the discovery/fulfilment rule is stated in full in three places — plan Fix,
design predicate section, design Rule 3; one can reference the others) to stay near the bound.

## Open questions for sparring (do not block)
- The two items already under plan.md "## Open questions for sparring" (D26 revenue-share split deferred to the
  commerce program; whether the health-category trust-2+DPA gate reads a Health-plan table not yet created at M2, and
  the `mt.discover_health_category` default-closed proposal). Both are legitimately cross-spec / downstream and are
  correctly parked, not blockers.

## Verdict basis
HIGH findings: 1 (HIGH-1). MEDIUM findings: 1 (MEDIUM-1). Count > 0 → REJECTED. The spec is close and its hardest
calls (per-query lineage guard, discovery-vs-fulfilment split, O5 reference) are correct and verified; the blocking
gap is that the reader inventory + lane paths do not actually cover every `products`/`merchants` reader the
build-failing lint will force the lane to touch.
