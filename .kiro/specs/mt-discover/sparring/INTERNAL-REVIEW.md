# Internal adversarial review — mt-discover (NN=12), before CI sparring

Reviewer: independent internal sparring step (fresh context, no planner reasoning).
Date: 2026-10-15. Repos read read-only: platform `C:\Users\dstev\vitana-platform-1`,
frontend `C:\Users\dstev\vitana-v1`. No git run, spec never edited.

## Method
Read BATCH-BRIEF.md (Internal-review criteria) and CROSS-SPEC-DECISIONS.md first, then every
mt-discover file (plan.md, requirements.md, design.md, tasks.md, handoff.md, lanes/*.md). Every
premise re-verified against current code with file:line. Ran the real `queue.mjs` validators
(`parseFrontMatter` + `validatePlan` + `validateLane`) on handoff.md and all four lanes.

## Verified assumptions (checked against current code)
1. **`supplier_tenant_relationships` absent** — grep across the whole platform checkout returns
   zero matches. Problem 1 accurate.
2. **Every `products`/`merchants` reader is global** —
   - `routes/discover-feed-repository.ts:39` `buildCandidateProductsFeedQuery` =
     `.from('products').select(...).eq('is_active', true).eq('availability','in_stock')`. ✓
   - `routes/discover-search-repository.ts:27-29` `buildProductSearchQuery` = `.from('products')...eq('is_active', true)`. ✓
   - `services/orb-tools/marketplace-guide-tools-repository.ts:42` and `:55` — two
     `.from('products').eq('is_active', true)` readers. ✓
   - `routes/shop-feed-repository.ts:~33` `fetchProductsByIds` reads `products` (by id). ✓ (see M1)
   - `services/checkout/checkout-service-repository.ts:~44` `fetchProductsByIds` reads `products` (by id). ✓ (see M1)
   Problem 2 accurate; the list is a real reader set.
3. **`tenant_catalog_overrides` exists, unenforced** — defined in
   `supabase/migrations/20260416120000_vtid_02000_marketplace_foundation.sql:326`, RLS
   `tenant_catalog_overrides_select` = `tenant_id = public.current_tenant_id()` (line 809-811),
   and the table COMMENT (line 866/881) says `merchants`/`products` are global and "tenants hide
   via tenant_catalog_overrides" — directly corroborating the design premise. No reader enforces
   it today. Problem 3 accurate.
4. **`products.distribution` absent** — no `distribution` match in the marketplace foundation
   migration. Problem 4 accurate.
5. **`partner_tenant.tenant_id` is free text** — `services/gateway/src/services/partner-onboarding-service.ts:~946`
   inserts `tenant_id: caller.tenantId || 'platform'`. Problem 5 accurate (plan cites :948; the
   insert object spans ~944-958, close enough — not a finding).
6. **`credit-recommender.ts` exists** at `services/gateway/src/services/recommendation-commissions/credit-recommender.ts`. Problem 8 target real.
7. **Frontend Discover page exists** at `vitana-v1/src/pages/Discover.tsx`. R9/U1 target real.
8. **Cross-spec O5 is correctly applied.** mt-community-isolation's `platform-only-accounts-db`
   lane (`.kiro/specs/mt-community-isolation/{plan,requirements,design,tasks,lanes}.md`) creates the
   `platform_only_accounts` view at the pinned C3 version `20261101070160` and adds it to the
   rule-45 lint. mt-discover's plan "Out of scope", design rule 5, requirements "Program position"
   and handoff all state it only *references* the view and create nothing; there is no stale Risks
   line about it. O5 confirmed clean.
9. **Migration range NN=12 (`20261101120000-125959`) does not collide** with
   mt-community-isolation's reserved `20261101070160` (C3) or mt-tenant-admin's `070100/070150/070600`.
   The four migration filenames in the DB lane are inside the range. No collision.
10. **queue.mjs validators pass with zero errors** on handoff.md and all four lanes (ran the real
    exported `validatePlan`/`validateLane` with correct signatures `(fm, slug[, lane, laneIds])`).
    No HIGH from the mechanical gate.

## Lane sizing / DB-code split / deps
- Four lanes: one DB (`supplier-relationships-db`, seat hotmail), two gateway code
  (`discover-shared-predicate` + `supplier-onboarding-communities`, seat jtadic), one frontend
  (`discover-mode-ui`, seat exafyltd). DB split from code per §4.7. ✓
- `reviewer_seat` ≠ `seat` on every lane (jtadic/hotmail/exafy/jtadic reviewers). ✓
- depends_on chain: `supplier-relationships-db` (none) → `discover-shared-predicate` and
  `supplier-onboarding-communities` (both → db) → `discover-mode-ui` (→ shared-predicate). Acyclic,
  all ids are lanes of this spec. ✓
- All four `executor: kiro`; no lane reaches a governance path (validator `globTouchesGovernance`
  check passed). ✓ No Claude lane is needed — correct, since this spec touches no `.github/**`,
  `.claude/**`, `.kiro/steering/**`, `scripts/collab/**`, `CLAUDE.md` or `areas.yaml`.
- Each lane states it is 1 VTID and 2-4 PRs' worth of work; sizes look reasonable (the DB lane is 4
  migrations + pgTAP; the predicate lane is one module + inventory + guard + suites).

## Standing rules
- **Dark by default** (`MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.discover_tenant_gate`
  / `mt.network_enabled`) stated in plan Rollout, every lane, R10/D7 (Maxina unchanged while off). ✓
- **Rules 31/31b/48** — production read-only, staging read-only with non-GET network guard, writes
  proven by Vitest/pgTAP only; executor never calls a live write endpoint (stated in the DB and
  onboarding lanes explicitly). ✓
- **Rules 43-45** — platform-only/test/service accounts never surfaced; design rule 8 + requirements
  non-functional. ✓ (and O5's `platform_only_accounts` is the mechanism, owned upstream).
- **42c/42e/42h** — `npm run test:support`, `npm run test:operator` when touched; ORB dispatcher
  tests on Nova + Vertex Serbian bridge if the ORB product/cart dispatch changes (P6). ✓
- **i18n DE-first du-form + RTL, Spotlight, Commerce UX contract** — all in the UI lane (U2/U3) and
  design. ✓ **What's New / nav-registry / screen-manifest / parity-ledger** — correctly N/A because
  no new App.tsx route is added (control on existing Discover screen); the lane states that if a
  route is added, the three registry updates ship in-lane. ✓
- **Bedrock-only / no Google beyond carve-outs** — nothing in this spec introduces an LLM/provider
  dependency; the ORB dispatcher test note references the existing Serbian bridge only. ✓
- **No duplication of DONE work** — M0 VTID-05147/05149/05150/05151 are referenced as done
  dependencies, not re-planned; the full eligibility engine, commission ledger, per-tenant money,
  Network groups and health-table re-keying are all explicitly Out of scope and assigned elsewhere. ✓

## Migration safety
- Expand/contract called out: `products.distribution` added with DEFAULT then default dropped
  (§4.7); `supplier_tenant_relationships` expand-only; `partner_tenant.tenant_id` backfill snapshots
  `bak_*` first and maps only unambiguous rows (unresolvable → NULL). ✓
- Rollback file + `live-before.sql` + `post-apply-checks.sql` + `lock_timeout`+retries + a
  MIGRATION-QUEUE row at the WS11 position + drift-baseline add/remove — all stated (plan Migrations,
  D5, design). DB applied by Claude via RUN-MIGRATION. ✓

## Findings

1. **MEDIUM — `discover-shared-predicate` (design.md "discover-shared-predicate", plan Fix,
   requirements R1/R3; tasks P1/P2).** Two of the Problem-2 readers —
   `shop-feed-repository.ts fetchProductsByIds` and `checkout-service-repository.ts fetchProductsByIds`
   — are **by-id hydration/checkout lookups**, not open feed queries. The spec says "every reader in
   the Problem-2 set routes through [the predicate]" and the inventory lint "asserts each goes
   through the predicate". Forcing a tenant-visibility gate onto a cart/checkout hydration path can
   hide a product a member already saved or added to cart (bought while a supplier was active, now
   suspended for the tenant), producing a broken checkout rather than a visibility fix. The design
   never distinguishes "discovery/browse read" (must gate) from "by-id hydration/fulfilment read"
   (must resolve the known item). Fix: in design.md and R3/P2, split the inventory into two reader
   classes — `discovery` readers (feed/search/recommendations/ORB browse) that apply the full
   predicate, and `fulfilment` readers (checkout/cart/saved hydration by explicit id) that the lint
   requires to be *annotated* as fulfilment and NOT filtered by relationship/distribution (they may
   still honour an explicit `tenant_catalog_overrides` hide if product policy wants that, but must
   not 404 an in-flight order). State which of the 12 readers is which.

2. **MEDIUM — `supplier-relationships-db` (tasks D4; design "Referral attribution"; plan Fix /
   Migrations `..._referral_tenant_attribution.sql`).** The referral/commission tenant-attribution
   column is described only as "a `tenant_id` column on the order/commission row consumed by
   `credit-recommender.ts`" without naming the target table. The DB lane's allowed `paths` include
   **only** `supabase/migrations/...` and the migration must `ALTER` a concrete table, but neither
   the plan nor design names it (order? commission? `product_orders`? the recommender's own table?),
   and the consuming code lives in the *other* lane (`supplier-onboarding-communities`). An
   unnamed-table migration cannot be reviewed for expand/contract safety or for whether the column
   already exists. Fix: name the exact table(s) the migration alters (verify the real table name in
   `credit-recommender-repository.ts` / the marketplace migrations — e.g. confirm whether it is
   `product_orders` from the foundation migration), and state that D4 (DB column) and S4 (recommender
   consuming it) are one logical change split across two lanes with S4 `depends_on`
   `supplier-relationships-db` (already declared) — add a one-line note in design that the column is
   added dark and read by S4 only behind the mt flags.

## Open questions for sparring (do not block)
- D26 revenue-share split math is explicitly deferred to the commerce program; mt-discover carries
  only the attribution columns. Confirmed consistent with the plan's own "Open questions" list.
- The health-category trust-2 + DPA gate may read a Health-plan table not yet created at M2; the
  plan proposes shipping it behind `mt.discover_health_category`, default-closed. Reasonable; left
  to CI sparring to confirm the flag name and the closed-default behaviour.

## Verdict
Two MEDIUM findings → CHANGES_REQUESTED (REJECTED). Both are clarifications the planner can resolve
in one revision (classify the reader set; name the attribution table). Everything mechanical
(validators, cross-spec O5, migration range, DB/code split, dark-by-default, standing rules) is
clean.
