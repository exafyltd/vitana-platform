# Acceptance: VTID-05802 (lane-executor-transfer)

Plan: .kiro/specs/lane-executor-transfer/plan.md (converged, hash a652316b).

- TEST g: a kiro lane whose builder commits `executor: claude` plus a `transfer: kiro→claude, by <claim holder>` entry passes Lane scope. Passing (outputs/queue-test-run.txt).
- TEST h: a changed `executor` without a transfer entry is refused by Lane scope. Passing (regression guard).
- TEST i: a transfer entry naming a session that did not commit to the lane is refused. Passing (regression guard).
- Seat carve-out in validateRange: a Claude session builds only after a transfer to claude recorded by a session of the range. Covered by the code path; the dedicated validateRange test (plan test j) is NOT yet written.
- NOT in this change: the rule text in collaboration.md and the Kiro steering pointer (lane paths list them); the Collab handoff claim check beyond the seat carve-out.
- Full collab suite: 258 of 260 pass. The one failure, "case 6: the real checkout(s) generate a clean set", is red on the base commit too.
