# Sparring round 1 — in_progress

Session: `07ac7369-6360-430d-92dd-46c052b486e6` · plan hash `b46cbd5b0e48babf7d0155f673f4a6e11ac3590288c02e3817462a5aaf09a154`

## Summary

The plan's core premises are well-verified against the codebase. The 35 role-modes rows (8 patient + 8 professional + 8 staff + 10 commerce role-route + 1 commerce exclusion) are confirmed in the parity ledger, all with `status: "not_started"` and `lane: "role-modes"`. The class-B determination of `role-switch-destination.ts` is correctly reasoned through the verified import chain. The already-in-core status of `business-mode`, `drawer-nav`, and `permissions` is confirmed. One minor governance gap identified.

## Findings

### R1-F1 [minor]

The re-plan note acknowledges the old spec was 'not listed in docs/programs/native-app/program.md' as one of two reasons for the re-plan, but the plan body does not include an explicit task or step to add this new spec (under its new slug) to program.md. If the executor lands lanes without adding the spec to the program doc, the same governance gap the re-plan was created to fix would persist.

- `exafyltd/vitana-v1:apps/mobile/parity/ledger.json:1` — VTID-05157 — native parity ledger, one row per web destination (program §4)

Suggestion: Add an explicit task (or a pre-merge gate) stating that the spec must be listed in docs/programs/native-app/program.md before/with the first lane PR.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
