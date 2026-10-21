# Sparring round 2 — converged

Session: `cc9a79de-e669-416e-bcd3-ed6a7056d041` · plan hash `dbb2adbf6d6c03bb66252f9049fa5697c70c93ec31365aba4420c5e798925b89`

## Summary

All three R1 findings were accepted and properly addressed in the revised plan. The stale detail.missing handling (R1-F1), website code (R1-F2), and typeless next_action.owner (R1-F3) are all correctly specified now. One new minor finding regarding the ON_SCREEN_STEPS derivation that would change the MCP output for the `team` step, contradicting the plan's "byte for byte" claim.

## Findings

### R2-F1 [minor]

The plan says `ON_SCREEN_STEPS` becomes 'steps whose fixed owner is `supplier`', derived from the checklist module. The plan's supplier-owned steps are: terms, dpa, billing_mandate, results_channel, tracking_test, team. Today `ON_SCREEN_STEPS` is {terms, dpa, billing_mandate, results_channel, tracking_test} — it does NOT include `team`. Adding `team` to `ON_SCREEN_STEPS` would cause `shapeStatus` (line 474) to emit `done_on_vitanaland: true` and a `link` on the `team` step in every MCP status response. Today `team` carries neither field. Moreover, because `team` has a special case at line 281 (`key !== 'team'` exempts it from `not_required`), its status is never `not_required`, so the condition at line 474 would always fire. This contradicts the plan's claim that '`done_on_vitanaland`, `link`, `tool` and `supplier_action` stay byte for byte'.

- `exafyltd/vitana-platform:services/gateway/src/services/commerce-mcp.ts:322` — /** Steps the supplier does on Vitanaland itself, never through the assistant. */
const ON_SCREEN_STEPS = new Set(['terms', 'dpa', 'billing_mandate', 'results_channel', 'tracking_test']);
- `exafyltd/vitana-platform:services/gateway/src/services/commerce-mcp.ts:473` — // VTID-04953: a not_required step is not something to do on Vitanaland.
        ...(ON_SCREEN_STEPS.has(st.key) && st.status !== 'not_required' ? { done_on_vitanaland: true, link: `${portalUrl}/commerce?org=${org.id}` } : {}),
- `exafyltd/vitana-platform:services/gateway/src/services/partner-onboarding-checklist.ts:281` — if (!isRequired && key !== 'team' && status === 'todo') status = 'not_required';

Suggestion: Either (a) keep ON_SCREEN_STEPS as today's five keys and derive it as 'supplier-owned steps that have a STEP_SUPPLIER_ACTIONS entry' (team does not), or (b) explicitly acknowledge that team gains done_on_vitanaland and remove the 'byte for byte' claim for it. Option (a) is simpler and avoids a semantic change.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Accepted and addressed: the plan now checks facts_changed first and ignores detail.missing in that case.
- R1-F2: acknowledged — Accepted and addressed: website is now listed in the assistant codes.
- R1-F3: acknowledged — Accepted and addressed: next_action.owner is specified for typeless (assistant), complete (assistant), and empty (null) cases with Jest coverage.
