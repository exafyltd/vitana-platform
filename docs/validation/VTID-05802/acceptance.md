# Acceptance: VTID-05802 (lane-executor-transfer)

Plan: .kiro/specs/lane-executor-transfer/plan.md (converged, hash a652316b).

AC-1 Lane scope allows a change to `executor` only when the lane log holds a transfer entry from the trusted executor to the new one, committed by a session of the range.
TEST: scripts/collab/queue.test.mjs "transfer g" (passes), "transfer h" (refused without the entry), "transfer i" (refused for a session outside the range). Output: outputs/queue-test-run.txt.

AC-2 The full collab suite does not regress.
TEST: node --test scripts/collab/ run recorded in commands.log: 258 of 260 pass; the one failure, "case 6", is red on the base commit too.

Open, not in this change: plan test j (the validateRange seat case), the rule text in collaboration.md, and the Kiro steering pointer.
