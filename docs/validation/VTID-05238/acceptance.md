# VTID-05238 — Commerce step owner: who can finish each open step (gateway)

Approved by policy `converged-auto-v1` 2026-10-19T13:33:37.92+00:00 (CI-sparred, CONVERGED, 2 rounds, standard
class; sparring record `plan-sparring.md`). One of two lanes of the `commerce-step-owner` plan across
`exafyltd/vitana-platform` (this lane, `gateway-step-owner`, merges first) and `exafyltd/vitana-v1`
(`frontend-still-needed`, second). No migration, no new route, no write path. No change to registration/company
validation, verification, terms, lifecycle, submit or the checklist's status/missing/detail logic — `owner` is an
additive field.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: no new route. `GET /api/v1/partner-onboarding/:orgId` is already registered
(`services/gateway/src/routes/partner-onboarding.ts:300`, `router.get('/:orgId', requireAuth, requireOrgAdmin(), …)`)
and the router is mounted at `/api/v1/partner-onboarding` (`src/index.ts:1244`,
`mountRouterSync(app, '/api/v1/partner-onboarding', partnerOnboardingRouter, …)`). The checklist it returns now
carries `owner` on each open required step; the Commerce MCP status (same checklist) carries `owner` on open steps
and on `next_action`.
FINAL_URL: GET {gateway}/api/v1/partner-onboarding/:orgId
CURL_PROOF: staging only, read-only, by STAGING-VERIFY (`staging-tests.json` test 1): the route on the staging
gateway → 401 `application/json` without a login. The signed-in 200 shape (per-step `owner`) is read by the
frontend staging spec (vitana-v1 `frontend-still-needed`). Never run against production. Local proof: the Jest
suite below.
OASIS_PROOF: none — no new OASIS event; nothing is written.

## Acceptance criteria (requirements 1–4 and 8)

AC-1 (req 1): every open required step in the checklist carries `owner` ∈ {assistant, supplier, vitanaland}; done,
not-required and `not_required` steps carry none. `buildChecklist` sets it additively and changes no other field.
  TEST: services/gateway/test/vtid-05238-step-owner.test.ts ("buildChecklist — owner is additive only")

AC-2 (req 2): the verification step's owner follows its open checks — `facts_changed` (stale row, old
`detail.missing` ignored) → assistant; `review_note` → supplier; `email_not_verified`/`domain_proof` → supplier;
an unknown code → supplier, and an unknown code wins over an assistant code checked alongside it
(`['vat_id','some_new_check']` → supplier, R2-F2); `website`/`vat_id`/`vat_invalid`/`*_check_unavailable` →
assistant; `business_verification*`/`licence*` → vitanaland, and `in_progress` with no code → vitanaland; a
never-checked `todo`/`failed` verification with no codes → assistant (R2-F1), because "run the checks" is the
assistant's job — `vitanaland` applies only to a `business_verification*`/`licence*` code or `in_progress`.
  TEST: services/gateway/test/vtid-05238-step-owner.test.ts ("stepOwner — verification, first match wins" incl. the
  never-checked todo/failed (R2-F1) and unknown-wins (R2-F2) cases, and the stale-row / website cases under
  "buildChecklist")

AC-3 (req 3): the Commerce MCP status carries the same `owner` per open step and on `next_action`
(typeless business_type → assistant; checklist complete → assistant; no step → null); `done_on_vitanaland`, `link`,
`tool` and `supplier_action` are byte for byte as today.
  TEST: services/gateway/test/vtid-05238-step-owner.test.ts ("shapeStatus — owner on open steps and byte-for-byte
  fields", "next_action.owner") + existing commerce-mcp suites

AC-4 (req 4): one source — the MCP's supplier-only on-screen set is derived from the checklist module as "fixed owner
`supplier` AND an entry in `STEP_SUPPLIER_ACTIONS`", exactly the five keys (terms, dpa, billing_mandate,
results_channel, tracking_test); `team` is excluded (R2-F1).
  TEST: services/gateway/test/vtid-05238-step-owner.test.ts ("ON_SCREEN_STEPS / STEP_TOOLS consistency (R2-F1)")

AC-5 (req 8): no migration, no new route, no write; the status route is mounted on staging and refuses an
unauthenticated caller.
  CURL: GET /api/v1/partner-onboarding/00000000-0000-4000-8000-000000000000 → 401 (staging-tests.json)
