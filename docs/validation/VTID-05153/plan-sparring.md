# VTID-05153 — Plan sparring record (Loop Engineering Phase 5 — L9 Supplier catalog, wave 1)

Plan hash (canonical, `services/gateway/src/services/plan-sparring/canonical-hash.ts`, text between the plan markers as approved): `0123933248f7b3c7728e19cef7fe3cb5fa539b082f5a6a008320c2cdd2b6f261`.
Partner: plan-sparring-partner agent (read-only), 2 rounds, standard class. Verdict: **CONVERGED**.
Owner approval: in session 2026-10-13, "Yes" in answer to the Phase 5 Gate 1 message.
Gate: allocated with `p_plan_hash` set to the hash above (VTID-05153, ledger id beb92a73-61a1-4a88-921a-d3267ac4db52); this record is referenced from the ledger row's metadata. Parent: VTID-05148.

---

# Loop Engineering Phase 5 — L9 Supplier catalog, wave 1 — plan for sparring

Parent: VTID-05148 (Phase 4). Doctrine: `docs/autonomy/LOOP-ENGINEERING.md` §6 item 5 (line 144). Catalog: L9 Supplier catalog (`services/gateway/specs/loop-catalog-v1.json:592-669`, cases S01–S10, C09; `uses_shared_verifiers: ["claim_verifier"]`). Commerce rules: `.claude/rules/backend.md` §13c-infra (1060-1100), `docs/COMMERCE-SUPPLIER-INFRASTRUCTURE-ARCHITECTURE.md`.
Repo: exafyltd/vitana-platform only.

<!-- plan:begin -->
## Change class
standard (gateway services, one routine, loops API + Command Hub Loops card, loop catalog. One additive seed migration that only inserts the routine's catalog row. No new table, no new column, no new LLM call).

## Goal
L9's wave-1 target: "80% of rows ready for approval without manual entry", one category, at most 20 SKUs per run, deterministic validators before any LLM, human publish gate. Here is what exists and what does not:
- **Ingestion already lands as normalized drafts.** Every supplier path writes `products` rows judged by one schema (`ProductFields`/`ProductSchema`, `routes/vcaop-portal-my-products.ts:262-305`) with `source_network='supplier_referral'` (`:145`) and `is_active=false` on insert (`services/partner-setup.ts:391-430`). The paths are: the CSV import (`services/partner-catalogue-csv.ts:1-24, 191`, route `routes/partner-onboarding-catalogue.ts:155-229`), the MCP `add_product` tool (`services/commerce-mcp.ts:446-503`, a "hidden draft"), and the deterministic Shopify `products.json` parser of AI setup (`services/commerce-ai-setup.ts:161, 210-216`, behind `COMMERCE_AI_SETUP_ENABLED`). `connect_store` only creates a connection and imports no products (`commerce-mcp.ts:506-560` → `partner-onboarding-service.ts:860-960`). `MARKETPLACE-SYNC-CRON` syncs affiliate networks, not suppliers (`services/marketplace-sync/shopify-sync.ts:1-21`).
- **Nothing checks a stored row after it is saved.** There is no media check, no duplicate check and no claim scan for the commerce catalogue. The architecture doc lists the claim scan as a "Gap" (`COMMERCE-SUPPLIER-INFRASTRUCTURE-ARCHITECTURE.md:90`). The only scan that exists is the keyword moderation for peer-to-peer listings (`services/community-marketplace/listing-moderation-check.ts:48-103`). No `claim_verifier` exists yet: only its name is in `services/loop-catalog.ts:36`, and Phase 6 builds it.
- **The publish gate is the org review plus a per-offering admin decision.** Approve is in `services/partner-review.ts:202-252`. Keep-offline and allow-listing are in `:320-372` and stored as `attributes.admin_listing`. The VTID-04769 gate trigger is in `supabase/migrations/20261001120000_vtid_04769_…sql:152-222`. That trigger fires `BEFORE INSERT OR UPDATE OF is_active, merchant_id` (`:220-222`); its INSERT branch can list a new row of an eligible org (`:169-180`).

Phase 5 adds one routine. It checks a category's supplier draft rows with deterministic rules, stores one result per row, sends rows that fail 3 times back to the supplier through the existing status and `next_action`, and measures the share of ready rows. Code never publishes and never writes `is_active`.

## Parts

### P1 — Deterministic checks (cases S02, S05, S06; S03 pre-screen only)
New pure module `services/catalog-check/validators.ts`. It has no I/O except the media probe, which is injected. Steps in order:
1. **Normalize (S02).** Lossless canonical form only: trim and collapse whitespace in title and brand, upper-case ISO codes, drop empty strings, de-duplicate `images`. The row is then re-parsed through `ProductSchema`, the same schema every ingestion path uses. Nothing is invented: a missing value stays missing and becomes an error.
2. **Required fields and money.** Reuse `isCompleteOffering` (`services/partner-onboarding-checklist.ts:130-146`) and add the following checks:
   - `price_cents` is an integer and > 0 for `kind=product` (deliberately stricter than `isCompleteOffering`, which accepts 0 — a free product is not ready for the marketplace);
   - `currency` is ISO 4217;
   - `compare_at_price_cents` ≥ `price_cents` when present;
   - at least one image for `kind=product`.

   Money stays integer minor units (§13c-infra rule 5).
3. **Duplicates within the supplier (S05).** Supplier rows carry no SKU or GTIN: `ProductFields` has neither (`vcaop-portal-my-products.ts:262-282`) and the CSV has no such column (`partner-catalogue-csv.ts:90-97`). They exist only as `products` columns (`20260416120000_…marketplace_foundation.sql:196`). The keys are therefore, in this order:
   - same non-null `gtin`/`sku` under the same merchant;
   - same canonical `affiliate_url` (lower-case host, `utm_*` stripped);
   - same normalized title.

   Duplicates are only searched within the same `partner_org_id`, so `duplicate_of: <product id>` always names a row of the same supplier; it is stored on the newer row.
4. **Media (S06).** A HEAD request for at most 3 images per row, with a 5 s timeout and at most 3 redirects. A 405 or 501 falls back to one GET with `Range: bytes=0-0`. The content type must be `image/*`. SSRF protection reuses `assertPublicHost` (`services/platform-detect.ts:93`) through a new exported `ssrfGuardedHead` next to `ssrfGuardedFetch` (`:135-160`). Accepted residual, the same as the existing helper's own header says (`:133`): the DNS check is not rebinding-proof; the probe reads no body, sends no credentials and follows each redirect only after re-checking its host. **Outage guard:** if more than half of a run's probes fail at the network level, that run records `image_unchecked` for every row. This gives no strike, so a failing egress cannot push good rows back to suppliers.
5. **Claim pre-screen (S03).** Decision: a pre-screen behind a seam that Phase 6 replaces. It does not defer S03.
   - `catalog-check/claim-prescreen.ts` exports `ClaimCheck = (text, locale) => { flags: string[] }`.
   - It ships a short EN/DE list of disease-claim patterns (cure, heal, treat, prevent plus a disease term; "heilt", "gegen Krebs" …).
   - A flag can only move a row to `needs_review` (a human decides). It never blocks a row, never edits copy, and nothing is ever recorded as "claims verified" (§13c-infra rules 2–3).
   - Phase 6 swaps the implementation behind the same signature.

   Why not defer: the wave-1 category is supplements, where disease claims are the highest-risk content. The cost is one file with no pass verdict.
6. **Certificates (S04): deferred.** No dated certificate data exists. `products.certifications` is undated free text (`marketplace_foundation.sql:233`). The evidence tables with `expires_on` are only designed so far (`COMMERCE-SUPPLIER-…md:197-267`, roadmap step 5 `:539`) and are not migrated. The check records certifications as `declared` and never as verified.

### P2 — Per-row result, 3 strikes, back to the supplier (S01 status → next_action)
- **Storage.** The result goes in `products.attributes.catalog_check`. It is a reserved key, following the `admin_listing` precedent (`partner-review.ts:351`, kept by `updateProduct` at `partner-onboarding-service.ts:522-537`). No new table: one jsonb object per row is all the loop needs, and the supplier portal and MCP already read `attributes`. Shape:
  - `{ v:1, state: ready_for_review | needs_fix | needs_review | returned_to_supplier, checked_at, content_hash, errors:[{code, field, params}], flags:[…], duplicate_of?, normalized:[fields], fingerprint, strikes }`.
  - `content_hash` (round 1, F8): sha256 of the supplier-mutable fields only — `title, description, price_cents, compare_at_price_cents, currency, images, affiliate_url, origin_country, ships_to_countries, ships_to_regions, category` and `attributes` minus the reserved keys. The routine's own write never changes it, so a result write cannot reset strikes.
  - Supplier view (round 1, F2): the supplier portal `GET /products` (`vcaop-portal-my-products.ts:334`) returns `attributes`; it is changed to replace `catalog_check` with a shaped `{ state, errors:[{code, field}], strikes }` (no `fingerprint`, `content_hash`, `normalized` or `duplicate_of` id — a duplicate shows as the error code `duplicate` with the other row's title). MCP `shapeProduct` already returns no `attributes` and gets only the shaped `state`.
  - Errors are codes plus params, never English text (backend-supplied UI text rule).
- **Reserved keys.** `ProductFields.attributes` gets a transform that drops exactly two keys, `admin_listing` and `catalog_check`, and keeps every other key (round 1, F3: `kind` and `source`, which `commerce-mcp.ts:495` sets after parsing, are untouched; the transform runs on supplier input only, and internal setters that add keys after parsing are unaffected). This closes injection on every create and patch path that parses with `ProductFields`/`ProductSchema`/`ProductPatchSchema` (`:316`); the CSV import has no `attributes` column (`partner-catalogue-csv.ts:90-97`), and the AI setup path is checked by a test that its attributes survive the transform. `updateProduct` also keeps `catalog_check` the same way it keeps `admin_listing`.
- **Write.**
  - Service role, written only when the row is unchanged since the read: a PostgREST `.match` on the validated scalars plus jsonb equality on `attributes`. A concurrent supplier edit matches 0 rows, and the row is checked again on the next run.
  - Normalization writes back only to rows that are not live (`is_active=false`). The routine only UPDATEs existing rows (never INSERTs) and its SET never contains `is_active` or `merchant_id`, so the column-level `UPDATE OF is_active, merchant_id` trigger does not fire and its INSERT branch is never reached (migration `:220-222`). A source test pins both: no INSERT into `products`, no `is_active`/`merchant_id` in any catalog-check write.
- **3 strikes (catalog stop rule).** A failing row is checked again on the next runs. `strikes` increments while the error `fingerprint` (sorted error codes) stays the same. At 3, the state becomes `returned_to_supplier` and automatic re-checks stop until the supplier changes the row (`content_hash` differs, which resets strikes).
- **Back to the supplier via the existing mechanism.**
  - `loadCatalogueSource` (`routes/partner-onboarding.ts:126-149`) already reads the org's products. `OFFERING_FIELDS` (`:118`) is not widened (round 1, F5); a separate count query (`attributes->catalog_check->>state = returned_to_supplier`, `head=true&count=exact`) runs in the checklist build only for orgs that have rows in the wave-1 category.
  - `buildChecklist` (`partner-onboarding-checklist.ts:198-290`) adds `missing: ['catalogue_fixes']` and `detail.returned_products` to the `catalogue` step. Its **status is not changed**, so lifecycle, submit and go-live behave exactly as today.
  - MCP `nextAction` (`commerce-mcp.ts:349-367`) returns `{step:'catalogue', tool:'update_product', supplier_action}` when that code is present and no earlier required step is open.
  - `list_products` (`shapeProduct`, `:421-432`) shows each row's `check {state, codes}`.
- **Reviewer view.** `reviewDetail` (`partner-review.ts:135-162`) adds `catalog_check` next to `admin_listing`. Keep-offline and allow-listing stay the only per-offering decisions.

### P3 — The `supplier-catalog-check` routine and the L9 metrics
- **Schedule and candidates.** New gateway-runner routine `supplier-catalog-check`, daily at 13:00 UTC, registered in `services/routine-runner/sources.ts:69-133` beside `learn-outcomes`. Candidates:
  - supplier rows (`source_network='supplier_referral'`) with `category = 'supplements'` (one constant), in orgs not `rejected`;
  - excluding test and service accounts (`lib/excluded-test-service-accounts.ts:23`, NEVER rules 43–45).

  Priority: unchecked or changed (`content_hash`) first, then `needs_fix` with strikes < 3 and last check > 20 h ago, then `ready_for_review` older than 7 days (media re-check). **Cap: 20 rows per run.**
- **Why a routine and not event-driven on submit.** Writes already run `ProductSchema` synchronously. The new checks need network probes (media) and a per-run cap, and the runner already provides exactly-once claims, `routine_runs` findings, stagnation stop and damping (`routine-runner/runner.ts:1-62`). It is off unless `ROUTINE_RUNNER_ENABLED` is set and never runs on staging (`:64-68`).
- **Metrics** (stored in the run's `findings.metrics`, catalog metric names):
  - `rows_auto_normalized`: rows ready with no supplier edit between first check and ready;
  - `validation_failure_rate`: failing rows / rows checked in the run;
  - `ready_for_approval_share`: `ready_for_review` / all checked category rows; **target 0.80**;
  - counts per state and per error code;
  - `time_to_listing` and `human_edits_per_listing`: `not_measured` with the reason. No number is invented.
- **Breach.** None in wave 1: poor supplier data is not a code failure, so it is never routed to self-healing. A crashed run is `failure`, and the existing stagnation stop applies.
- **API and screen.** `METRICS_ROUTINES` (`services/loop-catalog.ts:252`) gains `L9: 'supplier-catalog-check'`, so `GET /api/v1/autonomy/loops` returns L9 `metrics_latest` (`:259-311`). `frontend/command-hub/loops-catalog.js:67-86` `metricsText` gets an L9 branch.
- **LLM: none.** Extraction already exists in AI setup (`commerce-ai-setup.ts:420-429`, `callViaRouter`) and is untouched. Any later LLM step for exceptions is Bedrock-only with its own budget and comes in a later wave.

### Catalog and docs
- L9 stays PARTIAL. `sensors.routines` gets `["supplier-catalog-check"]`. The gap text now says what runs (normalize, required/money, duplicate, media, claim pre-screen, 3-strike return) and what does not (verified claims → Phase 6; certificate expiry → evidence tables; stock/reorder drafts S10; sync drift S07; WooCommerce feed import).
- `routines/supplier-catalog-check.md`; seed migration like `20261013210000_vtid_05148_learn_outcomes_routine_seed.sql` (INSERT `routines` row, ON CONFLICT DO NOTHING).
- Doctrine §6 item 5, CHANGELOG, DATABASE_SCHEMA (the reserved `attributes.catalog_check` key and the seed row).

## Out of scope
- Publishing or unpublishing anything; changing the VTID-04769 gate, lifecycle or submit rules.
- The shared claim verifier (Phase 6); certificate/evidence tables; WooCommerce or connected-store product import; sync drift (S07); supplier score (S08); price watcher (S09); reorder/purchase-order drafts (S10); affiliate link health (C09).
- vitana-v1 portal rendering of `catalogue_fixes` and the row codes. The API ships codes, so this is a follow-up VTID in that repo.
- Any commission input (§13c-infra rule 4).

## Files in scope
- services/gateway/src/services/catalog-check/{validators.ts, claim-prescreen.ts, run.ts} (new: loader and writer for the routine)
- services/gateway/src/services/platform-detect.ts (export `ssrfGuardedHead`, reusing `assertPublicHost`)
- services/gateway/src/services/routine-runner/{sources.ts, checks.ts}
- services/gateway/src/routes/vcaop-portal-my-products.ts (reserved-key strip in `ProductFields.attributes`)
- services/gateway/src/services/partner-onboarding-service.ts (`updateProduct` keeps `catalog_check`)
- services/gateway/src/routes/partner-onboarding.ts (`loadCatalogueSource` count); services/gateway/src/services/partner-onboarding-checklist.ts (`catalogue_fixes` code)
- services/gateway/src/services/commerce-mcp.ts (`nextAction`, `shapeProduct`); services/gateway/src/services/partner-review.ts (`reviewDetail`)
- services/gateway/src/services/loop-catalog.ts; services/gateway/src/frontend/command-hub/loops-catalog.js + index.html ?v=
- supabase/migrations/<new>_vtid_<X>_supplier_catalog_check_routine_seed.sql; routines/supplier-catalog-check.md
- services/gateway/specs/loop-catalog-v1.json, docs, tests, docs/validation/<VTID>/

## Test plan
- **Unit (Jest, fakes only; every write is proven here):**
  - normalizer: lossless, idempotent, nothing invented;
  - each validator at its boundaries (price 0, compare-at below price, bad currency, no image);
  - duplicate keys in order;
  - media probe with stubbed fetch (200 image, 404, non-image type, timeout, 405→ranged GET, private host refused) and the outage guard;
  - claim pre-screen EN/DE hits and misses, a flag never yields "verified" or a block;
  - strikes: same fingerprint 3× → returned, an edit resets;
  - candidate selection (category, cap 20, excluded accounts, priority order);
  - guarded write matches 0 rows after a concurrent edit;
  - **source test:** no catalog-check code writes `is_active`, `listing_hold` or `first_listed_at`, and nothing calls an LLM;
  - reserved keys dropped on create, patch and CSV;
  - `updateProduct` keeps `catalog_check`;
  - checklist `catalogue_fixes` leaves the step status and `evaluateVerification` unchanged;
  - MCP `next_action` and `list_products` shape;
  - `reviewDetail` carries `catalog_check`;
  - loops API L9 `metrics_latest`; metrics on fixture rows.
- **Regression:** existing partner-onboarding, commerce-mcp, partner-review and CSV suites stay green; loop-catalog test; seed migration on throwaway Postgres; full gateway suite.
- **Staging (read-only; staging shares production Supabase):**
  - unauthenticated `GET /api/v1/autonomy/loops` and `GET /api/v1/admin/partner-review/<id>` → 401 JSON;
  - the Command Hub bundle carries the L9 marker.
  - The runner is off on staging, so no write occurs.
- **After production (read-only):** the first `supplier-catalog-check` run row with the metrics and ≤ 20 rows checked.
<!-- plan:end -->


## Planner responses — round 1
- F1 [major] ACCEPTED. Trigger citation corrected (INSERT branch named); the safety argument is now "UPDATE only, never INSERT, never is_active/merchant_id in SET", pinned by a source test for both.
- F2 [major] ACCEPTED. The portal GET returns a shaped catalog_check (state, error codes/fields, strikes) — no fingerprint, hash, normalized list or duplicate_of id. Duplicates are searched only within the same partner_org_id, so no cross-supplier row is ever referenced.
- F3 [major] ACCEPTED. The transform drops exactly admin_listing and catalog_check and keeps every other key; kind/source set by commerce-mcp.ts:495 after parsing are unaffected; CSV has no attributes column; a test covers the AI-setup attributes.
- F4 [minor] ACCEPTED. Stated as an intentional divergence (stricter than isCompleteOffering).
- F5 [minor] ACCEPTED. OFFERING_FIELDS is not widened; a separate head/count query runs only for orgs with rows in the category.
- F6 [minor] ACCEPTED. Residual named (same as ssrfGuardedFetch's header): not rebinding-proof; no body read, no credentials, host re-checked per redirect.
- F7 [minor] ACCEPTED (no change). The pre-screen is a seam Phase 6 replaces; a hit only routes to a human, so false negatives cost nothing beyond today.
- F8 [minor→answered] ACCEPTED. content_hash is defined over supplier-mutable fields with the reserved keys excluded; the routine's own write cannot change it.
- Q1: see F8. Q2: no — duplicates are same-supplier only and the id is not shown. Q3: see F3 (narrow, explicit two-key strip).

## Round 2 — partner verdict
F1–F8 closed (verified against the revised plan and code: trigger :220-222 and :169-180, vcaop-portal-my-products.ts:334, commerce-mcp.ts:495, partner-catalogue-csv.ts:90-97, partner-onboarding.ts:118, partner-onboarding-checklist.ts:24). No new findings. Verdict: **CONVERGED**.
