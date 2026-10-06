# VTID-04890 — Plan sparring record

- Plan hash (sha256 of the text between the plan markers): `c610fe38e2ca7d216fa6fadfa3084609a8a6870e3959847b6160bea56bf9f761`
- Partner: independent `plan-sparring-partner` agent (read-only), 2 rounds
- Verdict: **converged**
- Owner approval: in chat, 2026-10-05 ("ok, approved"). Recorded in `vtid_ledger.metadata.plan_sparring` (session fallback: no gateway sparring record, this session has no service token or exafy_admin sign-in).

## Round 1 findings (partner, summarised verbatim in substance)

- F1 major — draft-only looked like it contradicted `COMPANY_EDITABLE_STATES` (`draft`, `needs_action`); a typeless org in `needs_action` would be stuck unless the plan states why that cannot happen.
- F2 minor — with business_type plus facts that void verification, the type would be written before the confirmation check.
- F3 minor — the status condition should name `body.checklist` / `body.organization.partner_type`.
- F4 minor — `updated_at` (already covered; no action).
- F5 minor — "only reachable through the MCP" should read "in this change only called by the MCP handler".
- F6 minor — the `needs_action` test should say why it tests an unreachable state.

---

# Plan — Commerce MCP: set a missing business type through `update_business`

Change class: **standard** (touches an MCP write tool and the partner onboarding service; no migration, no route, no auth change)
Repo: exafyltd/vitana-platform (gateway only)

<!-- plan:begin -->
## Problem (verified)

- A partner org registered through `POST /api/v1/partner-orgs/register` (`services/gateway/src/services/partner-setup.ts:105-156`) may omit `partner_type`; the column is nullable for that reason (migration `20260924130000_vtid_04471_partner_account_model.sql:53`).
- `loadChecklist` returns `checklist: null` when `partner_type` is not a valid type (`services/gateway/src/routes/partner-onboarding.ts:119`).
- `shapeStatus` (`services/gateway/src/services/commerce-mcp.ts:244-268`) then reports `ready_to_submit: false`, `missing_to_submit: []`, `steps: []`, `next_step: null` — an assistant cannot tell what to do.
- `partner_type` is only ever written by `startOnboarding` (insert) and `registerPartnerOrg` (insert). `updateCompany` (`partner-onboarding-service.ts:197-237`) only accepts legal_name/country/vat_id/website. So a typeless org can never get a type; `submitForVerification` refuses it with `PARTNER_TYPE_MISSING` (`partner-onboarding-service.ts:251`).
- `startOnboarding`'s dedupe looks for an existing draft with the SAME `partner_type` (`:141-151`), so an assistant that "repairs" by calling `create_business` creates a second org.
- Real instance: one org in production (Exafy ltd, draft, partner_type NULL). It is NOT modified by this change.

## Owner rule (fixed, not up for debate)

1. `update_business` may accept `business_type`.
2. Only while the business is in draft / pre-verification.
3. Only when the current type is null.
4. Once a type is set, `update_business` must not change it.
5. Status of a typeless business reports `missing_to_submit: ["business_type"]`, `next_step: "business_type"` and an assistant-facing hint to ask the supplier what kind of business it is.

## Design

### A. Service: new `setMissingPartnerType` in `services/gateway/src/services/partner-onboarding-service.ts`

```ts
export async function setMissingPartnerType(s, caller, orgId, partnerType: unknown, meta = {}): Promise<ServiceResult>
```
- `authorize` (org_admin / exafy_admin), same as every service call.
- `isPartnerType(partnerType)` else 400 `partner_type must be one of: …`.
- Load org; 404 if missing.
- `lifecycle_state !== 'draft'` → 409 `PARTNER_TYPE_LOCKED`. Deliberately narrower than `COMPANY_EDITABLE_STATES` (`['draft','needs_action']`, `partner-onboarding-service.ts:56`): the owner rule is draft/pre-verification only. Invariant, stated in a code comment: a typeless org cannot reach `needs_action` through the service, because `submitForVerification` refuses it with `PARTNER_TYPE_MISSING` (`:251`) and `needs_action` is only entered from `verifying`/`exception` (`partner-lifecycle.ts:53-55`). A legacy status-only write lands on `submitted`/`live`/`suspended`/`rejected` (trigger, migration `:113-121`), never `needs_action`. A typeless org outside draft is an admin case and gets the explicit 409, not a silent path.
- `org.partner_type` already set:
  - equal to the requested type → no-op, return `orgState` (idempotent retry is not an error);
  - different → 409 `PARTNER_TYPE_ALREADY_SET` with the current type.
- Race-safe write: `update({ partner_type, updated_at }).eq('id', orgId).is('partner_type', null).eq('lifecycle_state', 'draft').select('id')`; zero rows → re-read and answer as above (409 or no-op). The existing DB trigger `trg_partner_organizations_sync` re-derives `commerce_vertical` on the type change (migration `:127-130`), so no vertical logic in TS.
- OASIS event `partner_org.partner_type_set` (field + value only, the type is not sensitive), source from meta.
- Returns `orgState(s, orgId)`.
- Kept separate from `updateCompany` so the REST `PATCH …/company` route (`routes/partner-onboarding.ts:189`) and its contract do not change.

### B. MCP `update_business` (`services/gateway/src/services/commerce-mcp.ts`)

- Input schema gains `business_type` with the same enum and description as `create_business` (shared constant, not copied). Tool description adds: "business_type only when the status says it is missing; it cannot be changed once set."
- Handler order:
  1. `organization_id` required (unchanged).
  2. If facts are given, validate them first with `parseCompanyFacts` so an invalid fact fails before anything is written.
  3. If facts are given and `confirmed !== true`, run the existing verification-voiding check (`changeVoidsVerification`) BEFORE any write; `confirmation_required` returns with nothing written (type included).
  4. If `business_type` given → `setMissingPartnerType`; on error return it (nothing else written).
  5. If facts given → `updateCompany`, unchanged.
  6. If only `business_type` → return its status.
  7. Neither → existing 400 from `updateCompany` (unchanged behaviour).
- Never calls `startOnboarding` / never inserts into `partner_organizations`.

### C. Status for a typeless business (`shapeStatus`)

When `body.checklist` is null AND `body.organization.partner_type` is null:
- `next_step: "business_type"`, `missing_to_submit: ["business_type"]`, `ready_to_submit: false`, `steps: []` (unchanged),
- `hint`: "This business has no type yet. Ask the supplier what kind of business it is, then call update_business with business_type. Do not call create_business: that would create a second business."
- `business_types`: the allowed values (same constant).
Typed businesses: output byte-for-byte unchanged.

### D. Tests

`services/gateway/test/vtid-<VTID>-commerce-business-type.test.ts` (service with a fake Supabase that records writes; MCP via the existing `commerce-mcp.test.ts` harness):
1. draft + null type → type set; update filtered on `partner_type IS NULL` and `lifecycle_state = draft`; status returned.
2. draft + existing different type → 409 `PARTNER_TYPE_ALREADY_SET`, no write. Same type → no-op 200, no write.
3. `submitted`, `verifying`, `needs_action`, `live` with null type, and `live` with a type → 409 `PARTNER_TYPE_LOCKED`, no write. The `needs_action` case carries a comment: unreachable for a typeless org by construction, asserted as defense in depth.
4. Invalid type value → 400, no write. Non-admin → 403 before any read.
5. Race: conditional update matches 0 rows (type set concurrently) → 409, not a silent overwrite.
6. `shapeStatus` with null type → `missing_to_submit: ["business_type"]`, `next_step: "business_type"`, hint present; typed org output unchanged (snapshot of existing fixture).
7. MCP `tools/list`: `update_business.inputSchema.properties.business_type.enum` equals `PARTNER_TYPES`.
8. MCP `update_business` with `business_type` (+ facts): calls `setMissingPartnerType` then `updateCompany`; invalid fact → neither called; facts that void verification without `confirmed` → `confirmation_required` and neither called; `startOnboarding` never called (no duplicate business).
9. Existing `commerce-mcp.test.ts`, `vtid-04847`, `partner-onboarding.test.ts` stay green unchanged.

### E. Staging proof

`docs/validation/<VTID>/staging-tests.json`: read-only only —
- the new jest file (cwd services/gateway),
- the existing unsigned `POST /mcp` → 401 probe (the tool list is behind sign-in, so the schema is proven by jest, not on staging).
Owner verifies on staging through Claude: set Exafy ltd's type, checklist populates.

### Scope

Files: `partner-onboarding-service.ts`, `commerce-mcp.ts`, one new test file, `docs/validation/<VTID>/*`. No migration, no data change, no new route, no frontend, no flag change. Production unaffected (`COMMERCE_MCP_ENABLED` off there; in this change the new service function is only called by the MCP `update_business` handler).

### Out of scope

- Guarding `create_business` against creating a second org while the caller owns a typeless draft (the hint steers the assistant; a hard guard is a separate decision).
- Making `/register` require a type.
- Changing an already-set type (needs its own owner decision).
<!-- plan:end -->

## Planner responses — round 1

- F1 [major] ACCEPTED (option b). Draft-only kept (owner rule); the invariant and its code references are now stated in section A and carried as a code comment; the test for `needs_action` documents it as defense in depth.
- F2 [minor] ACCEPTED (option a). The confirmation check now runs before both writes (handler step 3); test 8 covers it.
- F3 [minor] ACCEPTED. Condition reworded to `body.checklist` / `body.organization.partner_type`.
- F4 [minor] No action (partner confirms the plan already sets `updated_at`).
- F5 [minor] ACCEPTED. Scope note reworded: in this change only the MCP handler calls it.
- F6 [minor] ACCEPTED. Folded into test 3.

## Round 2 — partner disposition

F1 closed (invariant chain verified: draft→submitted→verifying→needs_action; legacy trigger never yields needs_action). F2–F6 closed. No new findings.

## Verdict

CONVERGED after 2 rounds (change class standard, cap 3). No open or disputed blocker/major.
