# VTID-05238 — Plan sparring record

- **Plan:** commerce-step-owner — every open onboarding step says who can finish it (the supplier's AI assistant,
  the supplier, or Vitanaland), and the supplier screen groups "Still needed" the same way (follow-up 2 of
  VTID-05204).
- **Change class:** standard (gateway pure checklist function + Commerce MCP status shape in vitana-platform; one
  supplier screen + i18n in vitana-v1).
- **Final plan hash (sha256, text between the plan markers):**
  `dbb2adbf6d6c03bb66252f9049fa5697c70c93ec31365aba4420c5e798925b89`
- **Partner:** `plan-sparring-partner` (independent, read-only), 2 rounds.
- **Verdict:** CONVERGED — round 1: 1 major (R1-F1) + 2 minor (R1-F2, R1-F3), all accepted; round 2: all closed,
  one new minor (R2-F1), accepted in `tasks.md` T2. No unresolved finding.
- **Approval:** approved by policy `converged-auto-v1` at 2026-10-19T13:33:37.92+00:00 (CI-sparred, converged;
  replaces owner Gate 1 per CLAUDE.md / collaboration §7).
- **Session:** `cc9a79de-e669-416e-bcd3-ed6a7056d041`.
- **VTIDs:** VTID-05237 (plan coordination) & VTID-05238 (this lane, `gateway-step-owner`).
- **Repos:** `exafyltd/vitana-platform` (gateway, this lane) and `exafyltd/vitana-v1` (frontend);
  one VTID per lane.

## Round 1 — partner findings (verbatim)

### R1-F1 [major]

The proposed `stepOwner` verification logic uses the union `step.missing ∪ step.detail.missing` with 'first match wins' priority, checking supplier codes (email_not_verified, domain_proof) before assistant codes (facts_changed). When `verificationIsStale` fires (line 264-267), `step.missing` is overwritten to `['facts_changed']` but `step.detail` is preserved from the stored row, so `step.detail.missing` still contains the old verification's codes (e.g. `email_not_verified`). The union will contain both `facts_changed` and stale codes like `email_not_verified`. Because the supplier codes are checked first, the step owner would be `supplier` when `assistant` is correct (the assistant should re-run `check_verification` against the new facts).

- `exafyltd/vitana-platform:services/gateway/src/services/partner-onboarding-checklist.ts:258` — `const row = stored.get(key); if (row && isStepStatus(row.status)) { status = row.status; if (row.detail …) detail = row.detail; if (key === 'verification' && verificationIsStale(row.detail, input.org)) { status = 'todo'; missing = ['facts_changed']; } }`
- `exafyltd/vitana-platform:services/gateway/src/services/partner-onboarding-service.ts:723` — `const detail = { level_required: required, level_reached: outcome.level_reached, checks, missing: outcome.missing, … }`

Suggestion: Either (a) when `facts_changed` is present in `step.missing`, ignore `step.detail.missing` entirely (the stale codes are meaningless once facts changed), or (b) give `facts_changed` priority over all supplier codes in the match order — e.g. check `facts_changed` → `assistant` before checking `email_not_verified` → `supplier`.

### R1-F2 [minor]

The verification step can carry a `website` missing code (prepended at partner-onboarding-service.ts:720 when the org has no website host). The plan's stepOwner verification mapping does not enumerate `website`, so it falls through to the 'unknown code → supplier' default. In reality the assistant can set the website via `update_business`. The safe default is not harmful (it won't promise something the AI cannot do), but it is inaccurate — the supplier would see verification listed under 'Only you can do this' when the assistant could resolve it.

- `exafyltd/vitana-platform:services/gateway/src/services/partner-onboarding-service.ts:719` — `const outcome = computeVerification(required, checks); if (!host) outcome.missing.unshift('website');`

Suggestion: Add `website` to the assistant-owned codes in the stepOwner verification mapping (the assistant can call `update_business` to set it). Alternatively, document it in the table test so the unknown-code fallback is a conscious choice.

### R1-F3 [minor]

The plan says shapeStatus will add `owner` to `next_action`, but `nextAction` can return the pseudo-step `business_type` for typeless orgs (line 370), which is not a ChecklistStep and has no stepOwner. The plan does not specify what `owner` value `next_action` gets in the typeless case.

- `exafyltd/vitana-platform:services/gateway/src/services/commerce-mcp.ts:370` — `if (typeless) return { step: 'business_type', tool: 'update_business', supplier_action: null, link: null };`
- `exafyltd/vitana-platform:services/gateway/src/services/commerce-mcp.ts:444` — `const typeless = !checklist && org.partner_type == null; … const action = nextAction(checklist, typeless, …);`

Suggestion: Specify that `next_action.owner` is `'assistant'` when typeless (the tool is `update_business`), or null when there is no next step. Add a test case for the typeless path.

## Round 1 — planner responses

- **R1-F1 ACCEPTED** — Confirmed: on a stale verification `buildChecklist` sets `missing` to `['facts_changed']`
  but keeps the stored row's `detail` (partner-onboarding-checklist.ts:258-267), so `detail.missing` still holds the
  old codes. Option (a) taken: `facts_changed` is checked first and maps to `assistant`, and `detail.missing` is
  ignored in that case. A Jest case pins it (`facts_changed` with an old `email_not_verified` in `detail.missing`
  → `assistant`).
- **R1-F2 ACCEPTED** — Confirmed at partner-onboarding-service.ts:720 (`outcome.missing.unshift('website')` when the
  org has no website host). `website` is added to the assistant codes (`update_business` sets it) and to the table
  test.
- **R1-F3 ACCEPTED** — `next_action.owner` is now specified for every case `nextAction` produces: the owner of
  `next_action.step`; the typeless pseudo-step `business_type` → `assistant` (`update_business`); no step with tool
  `submit_for_verification` (checklist complete) → `assistant`, still behind the supplier's `confirmed=true` as
  today; no step and no tool → `null`. Jest cases for the typeless, complete and empty paths.

## Round 2 — partner re-review (verbatim)

### R2-F1 [minor]

The plan says `ON_SCREEN_STEPS` becomes 'steps whose fixed owner is `supplier`', derived from the checklist module. The plan's supplier-owned steps are: terms, dpa, billing_mandate, results_channel, tracking_test, team. Today `ON_SCREEN_STEPS` is {terms, dpa, billing_mandate, results_channel, tracking_test} — it does NOT include `team`. Adding `team` to `ON_SCREEN_STEPS` would cause `shapeStatus` (line 474) to emit `done_on_vitanaland: true` and a `link` on the `team` step in every MCP status response. Today `team` carries neither field. Moreover, because `team` has a special case at line 281 (`key !== 'team'` exempts it from `not_required`), its status is never `not_required`, so the condition at line 474 would always fire. This contradicts the plan's claim that '`done_on_vitanaland`, `link`, `tool` and `supplier_action` stay byte for byte'.

- `exafyltd/vitana-platform:services/gateway/src/services/commerce-mcp.ts:322` — `const ON_SCREEN_STEPS = new Set(['terms', 'dpa', 'billing_mandate', 'results_channel', 'tracking_test']);`
- `exafyltd/vitana-platform:services/gateway/src/services/commerce-mcp.ts:473` — `...(ON_SCREEN_STEPS.has(st.key) && st.status !== 'not_required' ? { done_on_vitanaland: true, link: … } : {}),`
- `exafyltd/vitana-platform:services/gateway/src/services/partner-onboarding-checklist.ts:281` — `if (!isRequired && key !== 'team' && status === 'todo') status = 'not_required';`

Suggestion: Either (a) keep ON_SCREEN_STEPS as today's five keys and derive it as 'supplier-owned steps that have a STEP_SUPPLIER_ACTIONS entry' (team does not), or (b) explicitly acknowledge that team gains done_on_vitanaland and remove the 'byte for byte' claim for it. Option (a) is simpler and avoids a semantic change.

### Acknowledgements of earlier responses

- R1-F1: acknowledged — Accepted and addressed: the plan now checks `facts_changed` first and ignores
  `detail.missing` in that case.
- R1-F2: acknowledged — Accepted and addressed: `website` is now listed in the assistant codes.
- R1-F3: acknowledged — Accepted and addressed: `next_action.owner` is specified for typeless (assistant),
  complete (assistant), and empty (null) cases with Jest coverage.

## Round 2 — planner response (recorded in tasks.md T2)

- **R2-F1 ACCEPTED** — Option (a). `ON_SCREEN_STEPS` is derived as "a step whose fixed owner is `supplier` AND which
  has an entry in `STEP_SUPPLIER_ACTIONS`", which is exactly today's five keys (terms, dpa, billing_mandate,
  results_channel, tracking_test). `team` (fixed owner supplier, no supplier action) is excluded, so its MCP shape
  stays byte for byte. A Jest case asserts the derived set equals those five keys.

## Verdict

CONVERGED after 2 rounds. Approved by policy `converged-auto-v1` at 2026-10-19T13:33:37.92+00:00
(session `cc9a79de-e669-416e-bcd3-ed6a7056d041`, final plan hash
`dbb2adbf6d6c03bb66252f9049fa5697c70c93ec31365aba4420c5e798925b89`). VTIDs VTID-05237 & VTID-05238.
