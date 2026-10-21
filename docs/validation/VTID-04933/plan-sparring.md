# VTID-04933 — Plan sparring record

- Plan Sparring Gate: VTID-04868. Partner: `plan-sparring-partner` (independent, read-only), one agent across all rounds.
- Change class: standard (routes, auth, Command Hub page, lifecycle). Rounds: 3 (item 11 added by the owner after round 2,
  re-sparred in round 3).
- Final plan hash: `f18926c4e4ac41362a4b3e5a4588e64f53b0e46303f54d6bf10e919eac8d10d9`
- Verdict: **converged** (round 2, and again in round 3 after item 11).
- Owner approval: in session 2026-10-07 — B1/B2 decisions ("for v1, admin approval counts as Level 1 verification"),
  then "B1 approved with option 1 added, proceed" (option 1 = per-offering keep offline, item 11).

## Final plan

<!-- plan:begin -->
## Goal (owner, 2026-10-07)
"A supplier can register, accept terms, submit, be verified, add an offering through AI, and reach go-live readiness
without manual database intervention." This plan delivers B1 (admin review flow) + B2 (owner decision: for v1 an
admin approval counts as verification level 1; no external verification provider). B3/B4 (checklist policy) are a
separate, later plan.

## Current state (verified)
- `submitForVerification` (services/gateway/src/services/partner-onboarding-service.ts:315-382) moves draft →
  submitted → verifying → live|needs_action; EXAFY LTD is now `needs_action` (open: verification, catalogue, mapping,
  tracking_test, billing_mandate).
- Automatic verification (routes/partner-onboarding.ts:280-425) can never reach level ≥1: `business_verification`
  and `licence` are hard-coded `not_configured` (:355-356).
- Lifecycle graph (services/partner-lifecycle.ts:50-60) has verifying→{live,needs_action,exception,rejected},
  exception→{live,needs_action,rejected}, needs_action→verifying; nothing produces exception/rejected today.
- The only admin action is `POST /api/v1/partner-orgs/:orgId/activate` (routes/partner-orgs.ts:332-424): sets
  `status='active'` from pending_review/suspended/active; the DB trigger then sets lifecycle `live` — bypassing the
  lifecycle graph and the checklist, from any pre-live state including `draft`.
- No admin list/review endpoint, no admin screen.

## Change
### Gateway — new `routes/admin-partner-review.ts`, mounted at `/api/v1/admin/partner-review`
`requireAuth` + `requireExafyAdmin`; every write also `requireOwnSession` (refuses an assistant's delegated token).
`requireOwnSession` is extracted from routes/admin-partner-terms.ts:76 into a shared `middleware/require-own-session.ts`
and used by both files (no behaviour change for terms).
1. `GET /` — orgs awaiting review: lifecycle_state in (verifying, needs_action, exception), plus `?state=` filter
   (incl. live/rejected for history). Each row: id, display/legal name, partner_type, country, website, lifecycle,
   trust_level, submitted_at (from lifecycle events), terms accepted version, product count, open required steps
   (from the existing `loadChecklist`/`buildChecklist`).
2. `GET /:orgId` — one org: company facts, full checklist, the verification step detail, products (title, kind, price,
   is_active), terms acceptance, last 20 `partner_org.*` OASIS events.
3. `POST /:orgId/approve` `{ note? }` — allowed when lifecycle is verifying, needs_action or exception.
   - Writes the `verification` step row `done`, detail `{ method:'admin_approval', level:1, approved_by, approved_at,
     note, facts:{website,country,vat_id} }` (facts snapshot keeps the VTID-04486 staleness rule working).
   - Then sets `trust_level = max(trust_level, 1)` (trust_level = verification level reached; verified ≠ live). The
     step row is written first and is the source of truth; if the trust write fails the call returns 500 and a retry
     is idempotent.
   - Re-evaluates the checklist with the existing `evaluateVerification`: all required done → moves to `live` via the
     graph (needs_action→verifying→live, exception→live, verifying→live); otherwise the org stays/lands in
     `needs_action` with the remaining open steps. Approval = verified; it is NOT a go-live override.
   - Event `partner_org.review.approved` (+ the existing `partner_org.lifecycle_changed` per move).
4. `POST /:orgId/request-changes` `{ reason }` (required, ≤1000 chars) — allowed from verifying/exception → `needs_action`
   (from needs_action: records the reason only). Stores the reason on the verification step detail
   (`review_note`, status `todo`), so the supplier's checklist shows it. A request-changes after an earlier approval
   voids that approval: step back to `todo`, trust_level back to the level the automatic check reached (0 today). Event
   `partner_org.review.changes_requested`.
5. `POST /:orgId/reject` `{ reason }` (required) — allowed from verifying, exception or needs_action → `rejected`
   in ONE move: the lifecycle graph gains `needs_action → rejected` (services/partner-lifecycle.ts; checked during
   implementation that no SQL constraint encodes the graph). Terminal. Event `partner_org.review.rejected`.
6. Lifecycle moves reuse one guarded helper extracted from `submitForVerification` (compare-and-set on the current
   state; `canTransition` enforced), so no move can bypass the graph.

### Gateway — tighten the legacy shortcut
7. `POST /api/v1/partner-orgs/:orgId/activate`: the compare-and-set switches from the legacy `status` column to
   `lifecycle_state` — `UPDATE … SET status='active' WHERE id=… AND lifecycle_state IN (verifying, needs_action,
   exception, suspended, paused, live)`; the existing trigger still syncs lifecycle from status. Refused (409
   `ORG_NOT_ACTIVATABLE` naming the lifecycle state) from draft/submitted/rejected. Behaviour otherwise unchanged (health-registry bridge kept). The review flow above is the normal path.

### Gateway — keep an approval from being undone by the automatic check
8. `POST /:orgId/verification/check`: if the stored verification row is an unexpired admin approval (method
   `admin_approval`, facts unchanged), the automatic check still runs and reports its findings but does not downgrade
   the step or trust_level — it reads the stored step row's `detail.method` BEFORE writing either. If the company facts changed, the approval is stale exactly as today (VTID-04486).

### Command Hub — standalone page (pattern: jev.{html,js,css}, no app.js/index.html/nav change)
9. `services/gateway/src/frontend/command-hub/partner-review.{html,js,css}`: list (filter by state) → detail panel →
   Approve / Request changes (reason) / Reject (reason, confirm dialog). Uses the operator's own session token from
   localStorage like jev.js. English, admin-only. Ownership-guard allowlist entry for these three new files only.

### Supplier side — show the reviewer's message
10. Checklist API already returns step detail; add `review_note` to the verification step's `missing`/detail payload
    so the existing Commerce SetupHub and `get_onboarding_status` (MCP) can show "changes requested: <reason>".
    Frontend display in vitana-v1 = a one-line follow-up only if the existing step UI does not already render detail
    (checked during implementation; no new i18n strings unless needed → DE+EN catalog entries).

### Per-offering "keep offline" (owner decision 2026-10-07, option 1)
11. `POST /api/v1/admin/partner-review/:orgId/products/:productId/keep-offline` `{ reason }` and
    `POST …/products/:productId/allow-listing` (exafy_admin, own session; product must belong to a merchant of that
    org). keep-offline = `UPDATE products SET is_active=false WHERE id=…` — the existing VTID-04769 product trigger
    (supabase/migrations/20261001120000_vtid_04769_supplier_go_live_lists_products.sql:210-214) treats an
    is_active=false write as an admin decision: it sets `listing_hold=NULL` and `first_listed_at=COALESCE(…, now())`,
    and `refresh_supplier_listings` (:118-124) only re-enables rows with listing_hold NOT NULL or first_listed_at NULL,
    so the product stays off when the org goes live. No migration. allow-listing = `SET is_active=true`: on at once if
    the org is eligible, otherwise held (`listing_hold='org_not_live'`) and goes on with the org (:202-209) — this IS
    the explicit publication decision. The reason + actor are kept in `products.attributes.admin_listing` (no new
    column) and in OASIS events `partner_org.review.product_kept_offline` / `…product_listing_allowed`. The detail view
    shows each product's listing state (live / waiting for go-live / held / kept offline by admin). The Command Hub
    page gets the two buttons. Supplier write paths (MCP update_product, portal) never set is_active — re-checked in
    implementation; if one does, it is refused for a kept-offline product.

## Scope note
Admin approval grants level 1: enough for service_provider/supplier_shop (level 1) and affiliate_brand (0). Labs and
practitioner clinics (level 2) stay blocked at verification — out of scope (no such supplier today).

## Tests
- Jest: new `test/vtid-XXXXX-partner-review.test.ts` — auth (non-admin 403, delegated token 403), list contents,
  approve from each allowed state (live when checklist complete, needs_action otherwise; trust_level 1; step detail),
  request-changes and reject transitions and refusals from disallowed states, reasons required, events emitted;
  activate refused from draft/submitted/rejected and allowed from verifying/needs_action; automatic check does not
  downgrade an admin approval but stale facts still void it. In-memory Supabase mock as in existing partner tests.
- Existing partner-onboarding / partner-orgs / checklist tests stay green.
- Jest also: keep-offline / allow-listing auth, product-belongs-to-org check, events, attributes note; a SQL test on
  throwaway Postgres (existing SQL test harness) proving a kept-offline draft stays off when its org goes live and an
  allowed one goes on with the org.
- Staging (read-only): `GET /api/v1/admin/partner-review` unsigned → 401 JSON; signed in as the (non-admin) test user
  → 403, if the staging-verify runner supports an authenticated read-only GET (otherwise Jest covers the 403); `/command-hub/partner-review.html`
  served (200 text/html). No write in any staging test.

## Out of scope
B3/B4 checklist policy; Stripe/billing; tracking; Discover services category; e-mail notifications to suppliers.

Change class: standard (routes, auth, frontend file, lifecycle).
<!-- plan:end -->

## Round 1 — partner (verbatim)

## Verified premises

- **Claim: `submitForVerification` at lines 315-382 moves draft -> submitted -> verifying -> live|needs_action** -- TRUE. `/home/user/vitana-platform/services/gateway/src/services/partner-onboarding-service.ts:315-381` (function body ends at 381, not 382 -- minor). The `submitTransitions` helper at `partner-onboarding-checklist.ts:256-271` produces the ordered multi-step moves and `submitForVerification` applies them one at a time with compare-and-set.

- **Claim: `business_verification` and `licence` are hard-coded `not_configured` at :355-356, so automatic verification can never reach level >= 1** -- TRUE. `/home/user/vitana-platform/services/gateway/src/routes/partner-onboarding.ts:355-356` hardcodes both to `not_configured`. Level 1 checks require `business_verification` to be `met` (`passed` or `not_required`), per `partner-verification.ts:43` (`LEVEL_CHECKS[1] = ['vat', 'business_verification']`), and `not_configured` is neither. Types `supplier_shop` and `service_provider` require level 1 (`partner-onboarding-checklist.ts:57,59`), so they can never complete verification automatically.

- **Claim: lifecycle graph at partner-lifecycle.ts:50-60 has the stated transitions; nothing produces exception/rejected today** -- TRUE. `/home/user/vitana-platform/services/gateway/src/services/partner-lifecycle.ts:50-59` matches the stated graph exactly. No gateway route currently calls `canTransition` to move an org to `exception` or `rejected` -- `evaluateVerification` at `partner-onboarding-checklist.ts:238-248` only returns `'live'` or `'needs_action'`, never `'exception'` or `'rejected'`.

- **Claim: `POST /:orgId/activate` sets `status='active'` from pending_review/suspended/active and the DB trigger sets lifecycle `live`, bypassing the lifecycle graph from any pre-live state including `draft`** -- TRUE. `ACTIVATABLE_STATUSES = ['pending_review', 'suspended', 'active']` at `partner-orgs.ts:37`. A `draft` org has status `pending_review` (via `statusForLifecycle` at `partner-lifecycle.ts:84-85`), so activate fires. The DB trigger at `20260924130000_vtid_04471_partner_account_model.sql:114` maps `status='active'` to `lifecycle_state='live'` unconditionally. This truly bypasses the lifecycle graph and checklist.

- **Claim: `requireOwnSession` exists in admin-partner-terms.ts as a reusable pattern** -- PARTIAL. The function exists at `admin-partner-terms.ts:76` but it is defined as a LOCAL `async function` inside that route file, not exported. It is not a shared helper -- the plan says "same helper pattern", which is accurate (it is the same pattern to copy), but it is not literally reusable without extraction or duplication. This is minor; the implementation will presumably copy the pattern.

## Findings

F1 [major] Reject from `needs_action` requires a two-step transition (`needs_action -> verifying -> rejected`) but the plan does not address the intermediate state's semantic meaning or atomicity risk.

Evidence: The lifecycle graph at `partner-lifecycle.ts:54` shows `needs_action` can only go to `verifying`, and only `verifying` can go to `rejected`. The plan (line 46) says reject from `needs_action` goes via `needs_action -> verifying -> rejected`. This copies the `submitTransitions` pattern at `partner-onboarding-checklist.ts:267-271` where two DB writes happen sequentially. Between the two writes, the org is momentarily in `verifying` -- if the second write fails (network, constraint, concurrent update), the org stays in `verifying`, not `needs_action` or `rejected`. This is an inconsistent state: the admin intended a rejection but the org appears as "under review." The `submitForVerification` flow has the same risk but it is supplier-initiated and recoverable (supplier can resubmit); a failed admin rejection is not self-recoverable and has no OASIS event trail explaining why the org moved to `verifying` without a submission.

Suggestion: Either (a) add `rejected` as a direct target of `needs_action` in the lifecycle graph (it is a terminal state and the graph comment at line 44 already describes exception -> rejected), or (b) wrap both transitions in the plan's lifecycle helper with an explicit error-recovery clause that reverts the first transition if the second fails, or (c) acknowledge this as an accepted residual with a loud OASIS event on partial failure. Option (a) is cleanest.

F2 [major] The plan does not address what happens when `POST /:orgId/approve` marks verification `done` but OTHER required steps are still open -- specifically, the `trust_level` is set to 1 even though the org stays in `needs_action`.

Evidence: The plan says (line 36) "Sets `trust_level = max(trust_level, 1)`" unconditionally on approval, and then (line 38) "Re-evaluates the checklist...otherwise the org stays/lands in `needs_action`." So a `needs_action` org with 5 open steps gets `trust_level=1` even though it is not live. `trust_level` is used by `computeVerification` and the verification step logic -- an org with `trust_level=1` that later runs the automatic `verification/check` endpoint could behave differently than expected because the automatic check writes its own `trust_level` from `outcome.level_reached` at `partner-onboarding.ts:387-393`, potentially DOWNGRADING back to 0. The plan's item 8 (line 56-58) says the automatic check "does not downgrade the step or trust_level" when there is an unexpired admin approval, but `trust_level` is on the org row while the approval detail is on the step row -- ensure the implementation actually reads the step row before deciding whether to downgrade, or this protection is incomplete.

Suggestion: Clarify in the plan that the approve endpoint writes `trust_level = max(trust_level, 1)` AND marks the verification step `done` atomically, and that item 8's protection logic explicitly reads the step row's `method` field before touching `trust_level`. Better yet, do not write `trust_level` until the org actually transitions to `live`, since that is when it matters.

F3 [major] The activate endpoint tightening (item 7) adds `verifying`, `needs_action`, `exception`, `paused` to the allowed statuses, but the current code uses `status` (the legacy column), not `lifecycle_state`. The plan conflates the two.

Evidence: `ACTIVATABLE_STATUSES` at `partner-orgs.ts:37` is `['pending_review', 'suspended', 'active']` -- these are `status` values, not `lifecycle_state` values. The plan says (line 51) "refuse unless the org's lifecycle_state is verifying, needs_action, exception, suspended, paused or live" but the endpoint currently filters on `status`, not `lifecycle_state`. `verifying`, `needs_action`, and `exception` all map to `status='pending_review'` (via `statusForLifecycle` at `partner-lifecycle.ts:84-85`). The plan cannot restrict by lifecycle_state using the legacy `status` column alone because multiple lifecycle states share the same status value. The implementation must either switch the endpoint to use `lifecycle_state` or accept that the granularity is coarser than intended.

Suggestion: State explicitly in the plan whether item 7 switches the endpoint from `status` to `lifecycle_state` filtering. If it does, that is a larger refactor of the activate endpoint (the current compare-and-set is on `status`). If it does not, the effective restriction is "refuse from `status='rejected'`" which is narrower than what the plan describes but still useful.

F4 [minor] The plan references "same helper pattern as routes/admin-partner-terms.ts" for `requireOwnSession`, but that function is a file-local `async function`, not an exported helper.

Evidence: `admin-partner-terms.ts:76` defines `requireOwnSession` as a local function. It calls `requestDelegation` from `services/partner-terms.ts`. The pattern is sound but the plan should note that this is being duplicated (or extracted to a shared module), not imported.

Suggestion: Extract `requireOwnSession` to a shared middleware (e.g., `lib/require-own-session.ts`) and use it in both files, rather than duplicating. Mention this in the plan.

F5 [minor] The plan's staging test (line 78) checks `GET /api/v1/admin/partner-review` unsigned returns 401 and that the HTML file is served. This is adequate for a read-only staging check but does not verify the route is actually mounted behind `requireAuth` + `requireExafyAdmin` (a 401 could come from any auth middleware). Consider also checking that a valid non-admin token returns 403.

Evidence: Staging shares the production Supabase project (CLAUDE.md, "Why no host is exempt"). The staging test must be purely read-only, which it is. But a 401 for an unsigned request is the default for any authed route -- it does not specifically prove the `requireExafyAdmin` gate is working.

Suggestion: Add a staging test variant: authenticated as the test user (who is not an exafy_admin) -> expect 403 on `GET /api/v1/admin/partner-review`. This is still read-only and proves the admin gate.

F6 [minor] The plan does not mention the `VERIFICATION_LEVEL_REQUIRED` table when describing what "admin approval = verification level 1" means for each partner type.

Evidence: `partner-onboarding-checklist.ts:55-61` shows labs require level 2 and practitioner_clinics require level 2. An admin approval granting level 1 is sufficient for `supplier_shop` and `service_provider` (require 1) and `affiliate_brand` (require 0), but NOT for `lab` or `practitioner_clinic` (require 2). The plan's statement "for v1 an admin approval counts as verification level 1" is fine as a design decision, but the plan should explicitly state that labs and clinics will still be blocked at the verification step after an admin approval, because their required level is 2 and the admin approval only grants 1.

Suggestion: Add a note: "Admin approval grants level 1. Partner types requiring level 2 (lab, practitioner_clinic) will need a future B3/B4 extension or a separate admin override to reach `done` on the verification step."

F7 [minor] The plan says "Stores the reason on the verification step detail (`review_note`, status stays/turns `todo`)" for request-changes. If there is no existing verification step row (org never ran the automatic check), this upsert creates one with `status='todo'` and a `review_note`, which is fine. But if there IS an existing step row with `status='done'` (from a previous admin approval that was later reconsidered), setting it back to `todo` voids a completed step. The plan should clarify the intended behavior: does request-changes after a prior approval also void the approval?

Suggestion: State explicitly whether request-changes can follow a prior approval (approve then request-changes without intermediate reject). If yes, clarify that the verification step status reverts to `todo` and `trust_level` is potentially downgraded.

## Questions for the planner

1. For the reject-from-needs_action two-step transition (F1): is adding `rejected` as a direct transition from `needs_action` acceptable, or is the two-step pattern a deliberate constraint?

2. For the activate endpoint (F3): does item 7 switch from `status` to `lifecycle_state` filtering, or does it keep using `status`? The answer determines the real scope of the tightening.

3. Should an admin be able to approve, then request-changes on the same org without an intermediate reject? If so, what happens to the trust_level and the step status?

## Verdict

NOT CONVERGED -- F1, F2, and F3 are major findings that need resolution before the plan is ready for a VTID. F1 concerns a real partial-failure risk in the reject path. F2 concerns premature trust_level writes and the interaction with the automatic verification check. F3 exposes a column-identity confusion that will surface as an implementation bug if not clarified now.

## Planner responses — round 1
- F1 ACCEPTED — option (a): `needs_action → rejected` added to the graph; reject is one move.
- F2 PARTLY ACCEPTED — item 8 reads the step row's method before touching trust_level; step row first, idempotent
  retry. REJECTED: deferring trust_level to go-live — trust_level is the verification level reached, and an approved
  supplier IS level 1 even before every other step is done.
- F3 ACCEPTED — activate filters on lifecycle_state (status still written; trigger syncs).
- F4 ACCEPTED — requireOwnSession extracted to shared middleware.
- F5 ACCEPTED — authenticated non-admin 403 staging probe if the runner supports it, else Jest.
- F6 ACCEPTED — scope note added.
- F7 ACCEPTED — request-changes after approval voids it (step todo, trust_level back to the automatic level).

## Planner change after round 2 (owner decision 2026-10-07)
Item 11 added (per-offering keep offline / allow listing) — owner chose option 1 so a supplier's draft offering never
goes public automatically at go-live without an explicit decision.

## Round 2 — partner (verbatim)

## Round 2 — disposition of round 1 findings

- **F1** [was major] -- **closed.** Plan revised: `needs_action -> rejected` added directly to the lifecycle graph. Single-move reject from every allowed state. Verified that the SQL CHECK constraint at `supabase/migrations/20260924130000_vtid_04471_partner_account_model.sql:43` validates only the value set, not transitions, so the graph change needs no migration.

- **F2** [was major] -- **acknowledged.** The partial rejection is reasonable: `trust_level` represents the verification level reached, not go-live readiness, so writing it on approval is semantically correct. The accepted parts (step row written first, method check before trust_level write in item 8, idempotent retry) address the atomicity and automatic-check-interaction concerns. No remaining issue.

- **F3** [was major] -- **closed.** Plan revised: activate endpoint switches its WHERE to `lifecycle_state IN (...)`. The DB sync trigger at `20260924130000_vtid_04471_partner_account_model.sql:112-123` handles the status-from-lifecycle sync correctly when only `status` is explicitly set -- the `ELSIF NEW.status IS DISTINCT FROM OLD.status` branch fires and maps `active` to `live`. No conflict.

- **F4** [was minor] -- **closed.** Plan revised: `requireOwnSession` extracted to shared middleware.

- **F5** [was minor] -- **closed.** Plan revised: authenticated non-admin 403 test added with a sensible fallback to Jest if the staging runner does not support it.

- **F6** [was minor] -- **closed.** Scope note added at line 78-79, explicitly stating labs/clinics stay blocked at level 2.

- **F7** [was minor] -- **closed.** Plan revised: request-changes after approval voids it (step back to `todo`, trust_level reverts to automatic level).

## New findings (round 2)

No new blocker or major findings. The revisions are consistent with the codebase.

One observation (not a finding): the plan's item 7 now filters on `lifecycle_state` but still writes `status='active'`. The trigger at line 112-123 will then set `lifecycle_state='live'`, which means the endpoint bypasses the TypeScript lifecycle graph (`canTransition`) for its own state change. This is the same bypass as before, just with a tighter WHERE. The plan acknowledges this ("Behaviour otherwise unchanged") and positions the review flow as the normal path, so this is accepted design, not a gap.

## Questions for the planner

None remaining.

## Verdict

CONVERGED -- all three majors are closed or acknowledged with sound reasoning. No new blockers or majors. The plan is ready for VTID allocation.

## Round 3 — partner (verbatim)

## Round 3 — disposition of earlier findings

All F1-F7 from round 1 remain as resolved in round 2: F1, F3, F4, F5, F6, F7 closed; F2 acknowledged.

## Verified premises (item 11)

- **Claim: the VTID-04769 product trigger treats an `is_active=false` write as an admin decision, setting `listing_hold=NULL` and `first_listed_at=COALESCE(…, now())`** -- TRUE. `supabase/migrations/20261001120000_vtid_04769_supplier_go_live_lists_products.sql:210-214`, the `ELSE` branch of `trg_products_supplier_gate`'s UPDATE path (when `NEW.is_active` is false and not a merchant-move). Comment on line 211: "Switched off on purpose: never bring it back automatically."

- **Claim: `refresh_supplier_listings` (:118-124) only re-enables rows with `listing_hold IS NOT NULL OR first_listed_at IS NULL`, so a kept-offline product stays off when the org goes live** -- TRUE. Lines 117-124: the WHERE clause is `AND (listing_hold IS NOT NULL OR first_listed_at IS NULL)`. A product with `is_active=FALSE, listing_hold=NULL, first_listed_at=<timestamp>` (the state after keep-offline) fails both conditions and is skipped by the refresh.

- **Claim: allow-listing (`SET is_active=true`) goes on at once if eligible, otherwise held with `listing_hold='org_not_live'` and goes on with the org** -- TRUE. Lines 202-209: when `NEW.is_active` and `v_block <> 'eligible'`, the trigger sets `NEW.is_active := FALSE` and `NEW.listing_hold := v_block` (which is `'org_not_live'`). When the org later goes live, `trg_partner_org_refresh_listings` (lines 229-252) calls `refresh_supplier_listings`, which picks up `listing_hold IS NOT NULL` rows and enables them.

- **Claim: supplier write paths (MCP update_product, portal PATCH) never set `is_active`** -- TRUE. `ProductFields` at `vcaop-portal-my-products.ts:262-282` does not include `is_active`; `ProductPatchSchema = ProductFields.partial()` at line 316 inherits this omission. `PRODUCT_PATCH_KEYS` at `commerce-mcp.ts:364-373` (the MCP update_product mapping) also does not include `is_active`. The POST (create) route at line 383 hardcodes `is_active: false`. The `updateProduct` service at `partner-onboarding-service.ts:425` parses through `ProductPatchSchema`, so `is_active` is stripped from any input.

## New findings (round 3)

No new blocker or major findings. Item 11 correctly leverages the existing trigger machinery without needing a migration. The trigger's distinction between "admin decision" (`listing_hold=NULL, first_listed_at set`) and "gate hold" (`listing_hold set`) is the exact mechanism that makes keep-offline sticky and allow-listing deferred, and the plan reads it accurately.

One minor observation (not a finding): the plan stores the admin reason in `products.attributes.admin_listing` (line 86). The `attributes` column is a JSONB field already used by the supplier for vertical-specific fields (via `ProductFields.attributes`). A supplier PATCH could theoretically overwrite `attributes.admin_listing` since `ProductPatchSchema` includes `attributes` as `z.record(z.string(), z.unknown())`. The plan says (line 89-90) "if one does, it is refused for a kept-offline product" -- this is the right instinct but does not cover a supplier overwriting the admin_listing metadata on a product that was allowed (not kept offline). This is cosmetic (the listing decision is in the trigger state, not the attributes field), so it is not a finding, just something to be aware of during implementation.

## Questions for the planner

None.

## Verdict

CONVERGED -- all premises verified against the code with file:line evidence. No blocker or major findings. The plan is ready for VTID allocation.

## Implementation notes
- Round 3 observation: `updateProduct` drops a supplier-supplied `attributes.admin_listing` and carries the stored one
  over, so a supplier PATCH can neither forge nor erase the admin's listing note (covered in
  `test/vtid-04933-partner-review.test.ts`).
- Item 10: the gateway now returns `review_note` / `approved_by_vitanaland` on the verification step (checklist + MCP
  `get_onboarding_status`). The vitana-v1 SetupHub does not render step detail today, so showing the note there is a
  separate one-line frontend follow-up (DE+EN strings), not part of this PR.
