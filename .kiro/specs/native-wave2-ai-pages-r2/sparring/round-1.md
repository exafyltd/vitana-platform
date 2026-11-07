# Sparring round 1 — in_progress

Session: `7502dcda-00e5-49c5-828c-fadc41d6f909` · plan hash `faf6520786439f4d4d3ee07e78354b98dbce9bbfd23bb3680cb7dc3961bfa83c`

## Summary

The plan is well-structured. I verified the core premises about the parity ledger rows (11 of 12 directly confirmed, 12th inferred from lane_rules), the class-B determination for `useAIAssistants.ts`, the `shapeOf` query-stripping logic, the `core-closure.mjs` class-A gate, and the lane_rules longest-prefix matching for `/comm/talk-to-vitana`. The lane partition (5+6+1=12) is arithmetically correct and aligns with the ledger. I found no blocker issues. One minor governance item regarding program spec registration.

## Findings

### R1-F1 [minor]

The re-plan note says the old branch failed because 'the spec is not listed in docs/programs/native-app/program.md'. The new plan does not state that the spec for this new slug (native-wave2-ai-pages-r2) has been or will be added to program.md before implementation. If the program spec entry is still missing, the same governance issue that retired the old branch will recur.

- `exafyltd/vitana-v1:scripts/native/parity-scope.json:1` — "_comment": "VTID-05157 — scope and lane rules for the native parity ledger ... Program: docs/programs/native-app/NATIVE-APP-PLAN.md §2 decision 3 (scope), §5 Wave 2 (lanes)".

Suggestion: Explicitly state in the plan that the new slug's spec entry will be added to the program file (docs/programs/native-app/program.md or NATIVE-APP-PLAN.md, whichever is the authoritative list) as a pre-merge step, or confirm it is already present.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
