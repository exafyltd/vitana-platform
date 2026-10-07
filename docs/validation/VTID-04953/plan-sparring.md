# VTID-04953 — Plan sparring record

- Plan Sparring Gate: VTID-04868. Partner: `plan-sparring-partner` (independent, read-only), one agent across both rounds.
- Change class: standard. Rounds: 2.
- Final plan hash: `9466f0085bacfef6bda24d27258dde19e3cc85b02b57d22e852bc919cd535d31`
- Verdict: **converged**.
- Owner approval: 2026-10-07 in session — "both approved, proceed" (Gate 1, Autonomy Contract VTID-04947).

## Final plan

<!-- plan:begin -->
## Goal (owner, 2026-10-07)
"A supplier can register, accept terms, submit, be verified, add an offering through AI, and reach go-live
readiness without manual database intervention." Owner decisions:
- **B3:** for manual or MCP catalogues, mapping is complete when there is at least one complete offering. External-feed
  mapping applies only when an external catalogue connector exists.
- **B4:** for service_provider v1, tracking_test and billing_mandate are not required until those systems exist. "Do not
  keep fake mandatory checklist items that nobody can complete."

Change class: **standard** (checklist rules that decide go-live readiness; routes touched).

## Current state (verified in code and read-only in production, 2026-10-07)
- `REQUIRED_BY_TYPE.service_provider` (services/gateway/src/services/partner-onboarding-checklist.ts:50) =
  account, company, verification, catalogue, mapping, tracking_test, terms, billing_mandate.
- `mapping` is a stored-row step. Its only writer is `reconcileMappingStep()` (routes/partner-onboarding-connections.ts
  ~:105-140): `done` once any connection (integration_manifest via partner_tenant.partner_organization_id) is
  certified/live, `in_progress` while one exists, **no row at all when the org has no connection**. Its header says
  "Partners with a manual catalogue and no connection confirm mapping another way, which is not built yet." So a
  manual/MCP supplier can never finish mapping.
- `tracking_test` and `billing_mandate` have no writer anywhere in the gateway (grep), so no supplier of those types can
  ever finish them.
- `catalogue` is `done` when the org's merchant has ≥1 product (`catalogueStepStatus`, services/partner-setup.ts:208).
- `loadChecklist()` (routes/partner-onboarding.ts:116) builds the checklist for every consumer (routes, MCP status,
  partner-review, ORB commerce knowledge) from stored step rows + terms + member count.
- Production has exactly one partner organization: EXAFY LTD, service_provider, needs_action; open required steps
  mapping, tracking_test, billing_mandate; one offering, kept offline by admin decision; no connections.

## Change
### 1. B4 — service_provider requirements (pure rule change)
`REQUIRED_BY_TYPE.service_provider` drops `tracking_test` and `billing_mandate`. Nothing else changes for other types
(supplier_shop keeps both; affiliate_brand keeps tracking_test; lab/clinic unchanged). The steps stay in `STEP_KEYS`
and show `not_required` for service providers. A code comment and spec §6.1 note record: "v1 (owner decision B4,
2026-10-07): not required for service_provider until the tracking and billing systems exist; re-add when they do."

### 2. B3 — mapping for orgs without an external catalogue connector
- `ChecklistInput` gains `catalogueSource: { connections: number; completeOfferings: number }` (required field, so every
  caller must supply it — the compiler finds every call site).
- In `buildChecklist`, the `mapping` step:
  - `connections > 0` → unchanged: the stored row written by the connections reconcile is the source of truth.
  - `connections === 0` → derived: `done` when `completeOfferings >= 1`, otherwise `todo` with
    `missing: ['complete_offering']`; detail `{ source: 'catalogue', complete_offerings: n }`. A stale stored mapping
    row (none exist today) is ignored in this branch.
- `mapping` is added to the derived-step handling only for that branch; `DERIVED_STEPS` constant is not changed
  (it means "never overridden by a stored row", which is not true when a connection exists).
- **Complete offering** = a product of any merchant of the org with: non-empty `title`, `price_cents` not null,
  3-letter `currency`, non-empty `affiliate_url`, 2-letter `origin_country`, and at least one entry in
  `ships_to_countries` or `ships_to_regions` — the required fields of `ProductSchema` (routes/vcaop-portal-my-products.ts
  ProductFields + `shipsSomewhere`); optional fields (description, images, brand, category) are not required. Listing state is irrelevant: an offering kept offline by an admin still counts
  (mapping is about catalogue data, not publication).
- `loadChecklist()` additionally reads, in its existing `Promise.all`: (a) the org's connection count — head count on
  `integration_manifest` with the same `partner_tenant.partner_organization_id` filter as `listOrgConnections`; (b) the
  org's merchant ids (`merchants` where `partner_organization_id = org.id`, the existing `findOrgMerchant` table), then
  one products query for those merchant ids selecting only `title, price_cents, currency, affiliate_url,
  origin_country, ships_to_countries, ships_to_regions`, pre-filtered server-side on non-null `affiliate_url` and
  `price_cents`, capped at 200 rows (one complete row is enough; the cap bounds the read for large catalogues). The
  rows are counted with a shared exported `isCompleteOffering()` helper (pure, unit-tested). A read error fails the
  checklist load exactly like today's reads (no silent "done").
- The `catalogue` step is unchanged (still "≥1 product"); tightening it to complete offerings is not part of this
  decision.
- No stored row is written for derived mapping (same as account/company/terms), so no new writer and no event; the
  checklist is always computed fresh.

### 2b. Assistant guidance follows the mapping source
- `commerce-mcp.ts`: `nextAction()` and the step shaping choose the tool for `mapping` from the step itself: when the
  step's `detail.source === 'catalogue'` or `missing` contains `complete_offering` → `add_product` /
  `update_product` guidance ("Add one complete offering: title, price, link and where it ships."); otherwise (a
  connection exists) → `connect_store` as today. `connect_store` is never suggested to a supplier without a connection.
- `commerce-mcp.ts` shaping: `done_on_vitanaland`/`link` is added to an ON_SCREEN step only when its status is not
  `not_required` (tracking_test and billing_mandate for service providers would otherwise read as "done on
  Vitanaland").
- `orb/profile/commerce-knowledge.ts`: `STEP_LABEL.mapping` becomes "catalogue mapping (one complete offering, or a
  connected shop)"; not_required steps are already excluded from the open-step list there (verified in
  implementation; if not, excluded).

### 3. No automatic lifecycle move
Changing the rules does not move any organization. An org whose checklist becomes complete moves only through the
existing paths: the supplier re-submits (needs_action → verifying → live) or an admin approves in the review flow.
For EXAFY this means: after deploy its checklist shows every required step done; it stays needs_action until someone
submits or approves again. Going live would list nothing, because its only offering is kept offline by admin decision
(stays off at go-live — VTID-04933 SQL test). Whether to take EXAFY live is a separate owner decision, not part of this
change.

### 4. Docs
`docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md` §6.1: record both decisions (date, owner) and the
complete-offering definition; header comment of partner-onboarding-connections.ts updated ("manual catalogue: mapping
is derived from complete offerings, see checklist").

## Files in scope
- services/gateway/src/services/partner-onboarding-checklist.ts
- services/gateway/src/routes/partner-onboarding.ts (loadChecklist)
- services/gateway/src/routes/partner-onboarding-connections.ts (comment only)
- services/gateway/src/services/partner-setup.ts (export `isCompleteOffering`)
- services/gateway/src/services/commerce-mcp.ts (mapping guidance, ON_SCREEN annotation)
- services/gateway/src/orb/profile/commerce-knowledge.ts (mapping label)
- tests: services/gateway/test/vtid-04478-partner-onboarding-checklist.test.ts (pure rules; its `input()` helper gets
  the default `catalogueSource: { connections: 0, completeOfferings: 0 }`), test/commerce-mcp.test.ts (mapping
  guidance both ways, not_required annotation), the existing tests that
  build checklists with a fake Supabase (partner-onboarding*.test.ts, vtid-04933-partner-review.test.ts,
  commerce-mcp-related) updated only for the new reads; a new test file for B3/B4.
- docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md, docs/validation/<VTID>/

## Tests
- Pure: service_provider required set no longer contains tracking_test/billing_mandate, other types unchanged;
  mapping derived done/todo by complete offerings when connections = 0; stored row still wins when connections > 0
  (in_progress and done cases); kept-offline (is_active=false) complete offering counts; an incomplete product
  (no affiliate_url / ships nowhere) does not count.
- MCP: a manual-catalogue supplier whose next step is mapping gets `add_product`, never `connect_store`; one with a
  connection still gets `connect_store`; a not_required tracking_test carries no `done_on_vitanaland`.
- Route-level: GET checklist for a service_provider with one complete offering, no connections, verification done,
  terms accepted → `complete: true`, open steps none; submit from needs_action → live (existing path).
- Admin review: approve on such an org moves it to live; with the offering kept offline it stays off (existing gate).
- Staging (read-only): unsigned checklist GET still 401; no write.

## Out of scope
Building tracking or billing systems; Stripe; changing supplier_shop/affiliate_brand/lab/clinic rules; moving EXAFY's
lifecycle; the review-page usability fixes (separate plan).
<!-- plan:end -->

## Round 1 — partner (verbatim)

## Verified premises

- **`REQUIRED_BY_TYPE.service_provider` contains `tracking_test` and `billing_mandate`** --> TRUE -- `/home/user/vitana-platform/services/gateway/src/services/partner-onboarding-checklist.ts:50`
- **`reconcileMappingStep()` is the only mapping writer, at ~lines 105-140** --> TRUE -- `/home/user/vitana-platform/services/gateway/src/routes/partner-onboarding-connections.ts:105-141`. The header comment at line 29 also confirms: "Partners with a manual catalogue and no connection confirm mapping another way, which is not built yet."
- **`tracking_test` and `billing_mandate` have no writer anywhere in the gateway routes** --> TRUE -- grep of `services/gateway/src/routes` for `tracking_test|billing_mandate` returns zero matches. The only references are in the checklist definition (`partner-onboarding-checklist.ts:26,30,48,50,51`), the MCP shaping (`commerce-mcp.ts:268,278,279`), and the ORB knowledge labels (`commerce-knowledge.ts:22,26`).
- **`catalogueStepStatus` is at `partner-setup.ts:208`** --> TRUE -- `/home/user/vitana-platform/services/gateway/src/services/partner-setup.ts:208`. Returns `done` when `productCount > 0`, `in_progress` otherwise.
- **`loadChecklist()` at `partner-onboarding.ts:116`** --> TRUE -- `/home/user/vitana-platform/services/gateway/src/routes/partner-onboarding.ts:116-150`. Builds the checklist from stored steps + terms + member count, exactly as described.
- **Complete offering definition matches `ProductFields + shipsSomewhere`** --> PARTIAL -- `/home/user/vitana-platform/services/gateway/src/routes/vcaop-portal-my-products.ts:262-300`. The plan says the definition is "exactly the fields `ProductSchema` requires" but the plan's field list (`title`, `price_cents`, `currency`, `affiliate_url`, `ships_to_*`) omits `origin_country` (line 271: `z.string().length(2)`, required, not optional). Since every product must have `origin_country` at creation time, this is not a functional gap (every existing product has it), but the plan's "exactly" claim is wrong. See F3 below.

## Findings

**F1 [major] MCP assistant and ORB commerce knowledge will give wrong guidance for the mapping step when connections === 0**

Evidence: `commerce-mcp.ts:274` maps `STEP_TOOLS.mapping = 'connect_store'`, and `commerce-mcp.ts:299` falls back to "Finish this step on Vitanaland" when no tool matches. `commerce-knowledge.ts:21` labels mapping as `'shop connection'`. When a manual/MCP supplier has no connections and the mapping step shows `todo` (because they have no complete offering yet), the MCP assistant will tell them to call `connect_store` or go to Vitanaland to "finish the shop connection step" -- but what they actually need is to add a complete product. Neither file is listed in the plan's "Files in scope."

Suggestion: Add `commerce-mcp.ts` and `commerce-knowledge.ts` to the files in scope. When `connections === 0`, the mapping step's `missing: ['complete_offering']` (as the plan proposes) should be reflected in the MCP guidance: `STEP_TOOLS` should map `mapping` to `'add_product'` (or conditionally choose between `'connect_store'` and `'add_product'` based on the step's detail/missing), and `STEP_LABEL` in commerce-knowledge should say something like "catalogue mapping (complete an offering or connect a store)" or adapt based on the step's `detail.source`. Without this, the AI assistant gives actively misleading instructions to manual-catalogue suppliers.

**F2 [major] `nextAction()` in commerce-mcp.ts will direct manual-catalogue suppliers to connect a store even when the mapping step is derivable from complete offerings**

Evidence: `/home/user/vitana-platform/services/gateway/src/services/commerce-mcp.ts:288-301`. `nextAction()` reads `checklist.next_step` and looks it up in `STEP_TOOLS`. If `next_step === 'mapping'`, it returns `tool: 'connect_store'`. For a manual-catalogue supplier whose only open required step is mapping (no complete offering yet), the MCP will tell the assistant to call `connect_store` -- which will attempt to create a connection the supplier does not need. This is not just a label issue; it could trigger actual connection creation via the `connect_store` tool.

Suggestion: Either make `STEP_TOOLS.mapping` context-aware (using the step's `detail` or `missing` array to choose between `'connect_store'` and `'add_product'`), or split the mapping step's `next_step` value into two distinct identifiers so the MCP layer knows which action to recommend. This is tightly coupled with F1.

**F3 [minor] Plan's "complete offering" definition claims to be "exactly the fields ProductSchema requires" but omits `origin_country`**

Evidence: `/home/user/vitana-platform/services/gateway/src/routes/vcaop-portal-my-products.ts:271` -- `origin_country: z.string().length(2).transform(...)` is required (not `.optional()`). The plan lists `title`, `price_cents`, `currency`, `affiliate_url`, and `ships_to_*` but not `origin_country`. Since `ProductSchema` requires `origin_country` at creation, every existing product already has it, so `isCompleteOffering()` will never reject a product for this reason. The functional impact is zero, but the "exactly" claim in the plan text is inaccurate and could mislead reviewers.

Suggestion: Either add `origin_country` to the `isCompleteOffering()` check for correctness (it is always present), or change the plan text from "exactly the fields ProductSchema requires" to "the essential catalogue-completeness fields" and note that `origin_country` and other required-at-creation fields are excluded because they are always present.

**F4 [minor] Plan does not mention updating the existing test file's `input()` helper for the new required `catalogueSource` field**

Evidence: `/home/user/vitana-platform/services/gateway/test/vtid-04478-partner-onboarding-checklist.test.ts:23` -- `function input(over: Partial<ChecklistInput> = {}, org: Partial<ChecklistInput['org']> = {}): ChecklistInput`. Adding `catalogueSource` as a required field on `ChecklistInput` will break this helper's default (it does not supply `catalogueSource`). The plan mentions "the existing tests that build checklists ... updated only for the new reads" but does not call out that the test helper itself must be changed.

Suggestion: Mention in the plan that the `input()` helper in `vtid-04478-partner-onboarding-checklist.test.ts` needs a default `catalogueSource: { connections: 0, completeOfferings: 0 }` to keep existing tests compiling. This is mechanical but worth noting since the plan claims "the compiler finds every call site" -- the compiler will find this one too, but the plan should acknowledge it.

**F5 [minor] `ON_SCREEN_STEPS` in `commerce-mcp.ts:268` includes `tracking_test` and `billing_mandate` -- after B4, these become `not_required` for service providers, but the MCP shaping still marks them as `done_on_vitanaland: true` when they appear**

Evidence: `/home/user/vitana-platform/services/gateway/src/services/commerce-mcp.ts:268,333`. When `tracking_test` and `billing_mandate` are `not_required`, the step still appears in the checklist output with `status: 'not_required'`. The MCP shaping at line 333 adds `done_on_vitanaland: true` and a portal link for any step in `ON_SCREEN_STEPS` regardless of status. This is cosmetically wrong (a `not_required` step is not "done on Vitanaland") but functionally harmless since the step is already `not_required`.

Suggestion: Either filter `ON_SCREEN_STEPS` annotation to exclude `not_required` steps in the MCP shaping (line 333: add `&& st.status !== 'not_required'`), or note this as an accepted cosmetic issue. Low priority.

## Questions for the planner

1. The plan says the mapping step should be `done` when `completeOfferings >= 1` for orgs with no connections. But the MCP assistant will still tell those suppliers to "connect_store" for the mapping step (F1/F2). Is the intent that the MCP guidance should also adapt, or is this considered out of scope? If out of scope, what happens when the MCP assistant calls `connect_store` for a supplier that does not need one?

2. The plan proposes `isCompleteOffering()` as a shared exported helper in `partner-setup.ts`. `catalogueStepStatus()` already exists there and checks only product count. Should `isCompleteOffering()` also be used to refine the catalogue step (count only complete products rather than all products), or is that a separate change? The current `catalogueStepStatus(productCount)` counts ANY product, including incomplete ones.

3. For the `loadChecklist()` change: the plan says to add the org's products query to the existing `Promise.all`. That query needs to join through `merchants` (to get products for merchants with `partner_organization_id = org.id`). Is the intent to query `merchants` first, then products? Or a single joined query? The current `loadChecklist()` does not query products or merchants at all, so this is a new query path that should be specified more precisely for data volume and performance (how many products could an org have?).

## Verdict

NOT CONVERGED

F1 and F2 are open majors. The plan changes the mapping step's semantics for manual-catalogue suppliers but does not update the two downstream consumers (commerce-mcp.ts, commerce-knowledge.ts) that translate checklist steps into actionable guidance for the AI assistant. This means the MCP assistant will actively mislead manual-catalogue suppliers by telling them to connect a store they do not need. Both files need to be in scope and the plan needs to describe how the mapping step's MCP guidance adapts when `connections === 0`.

## Planner responses — round 1
- F1 ACCEPTED — commerce-mcp.ts and commerce-knowledge.ts in scope; mapping guidance follows the step's source (§2b).
- F2 ACCEPTED — `nextAction()` picks add_product for catalogue-sourced mapping; connect_store only when a connection exists. Test added.
- F3 ACCEPTED — origin_country added; wording changed to "the required fields of ProductSchema".
- F4 ACCEPTED — the `input()` helper default is named in scope.
- F5 ACCEPTED — ON_SCREEN annotation skipped for not_required steps (§2b), with a test.
- Q2: catalogue step unchanged (stated in §2); tightening it is a separate decision.
- Q3: two reads — merchant ids, then one products query on those ids with only the needed columns, server-side non-null filters, capped at 200 rows; specified in §2.

## Round 2 — partner (verbatim)

## Round 1 findings — disposition

- **F1 [major]** MCP assistant wrong guidance for mapping step --> **closed**. The planner accepted it. New section 2b adds `commerce-mcp.ts` to scope, makes `nextAction()` and the step shaping context-aware (detail.source/missing drives add_product vs connect_store). Both files are now in the scope list.
- **F2 [major]** `nextAction()` directs manual-catalogue suppliers to connect_store --> **closed**. Same acceptance as F1; 2b specifies that connect_store is never suggested to a supplier without a connection. MCP test case added (line 109-110).
- **F3 [minor]** Complete offering definition omitted `origin_country` --> **closed**. `origin_country` added to the definition at line 48. Wording changed from "exactly" to "the required fields of ProductSchema."
- **F4 [minor]** Test helper `input()` needs default `catalogueSource` --> **closed**. Explicitly named in the scope at lines 97-98.
- **F5 [minor]** `ON_SCREEN_STEPS` annotation for not_required steps --> **closed**. Addressed in 2b lines 70-72; MCP test added at line 110.

## Verified premises (revision)

- **commerce-knowledge.ts line 101 already excludes not_required steps from openRequired** --> TRUE -- `/home/user/vitana-platform/services/gateway/src/orb/profile/commerce-knowledge.ts:101`: `s.status !== 'not_required'` filter is present. The plan's claim at line 74 ("not_required steps are already excluded from the open-step list there") is correct.
- **`nextAction()` currently receives only `{ next_step, complete }`, not step-level detail** --> TRUE -- `/home/user/vitana-platform/services/gateway/src/services/commerce-mcp.ts:288-289`. The plan's 2b implicitly requires widening this input so the function can read `detail.source` or `missing`. This is an implementation detail the plan describes behaviorally; no design issue.
- **`findOrgMerchant` returns only one merchant (`.limit(1).maybeSingle()`)** --> TRUE -- `/home/user/vitana-platform/services/gateway/src/services/partner-setup.ts:228-229`. The plan's approach of querying all merchant ids for the org (line 54: "merchants where partner_organization_id = org.id") is correct and more thorough than the existing single-merchant helper.
- **The `ON_SCREEN_STEPS` annotation at commerce-mcp.ts:333 is unconditional on step status** --> TRUE -- `/home/user/vitana-platform/services/gateway/src/services/commerce-mcp.ts:333`. The plan's fix (line 70-72: skip when status is `not_required`) addresses this correctly.

## Findings

No new blocker or major findings. The revision addresses all five round-1 findings with concrete, code-consistent changes. The new section 2b is well-scoped and the file list, test list, and query approach are all consistent with the existing code structure.

## Questions for the planner

None.

## Verdict

CONVERGED
