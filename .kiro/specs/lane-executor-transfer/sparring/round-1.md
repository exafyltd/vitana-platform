# Sparring round 1 — in_progress

Session: `9ded0bb1-7922-4036-a161-933a50fd5379` · plan hash `c2a3c4b2f83c1810b15b1ca32cdf9e454fd364781cf42ff55f735692717ebae3`

## Summary

The plan proposes an "executor transfer" mechanism to move a lane between `kiro` and `claude` executors. The core protocol concepts (executor field, routing override, branch naming, trailers) are accurately described. However, the plan has a critical gap: it only addresses modifying `queue.mjs validate` (Collab handoff) but fails to account for `queue.mjs scope-check` (Lane scope), which enforces that `executor` — a PERM field — cannot be changed in a lane PR except by Claude-only sessions or a `lane_admin` lane. Both CI checks run independently (§9). Additionally, the multi-builder seat enforcement in `validateRange` would reject cross-executor sessions on the same PR. The `reseat` precedent cited is not analogous because it used `lane_admin` on other lanes, not self-modification.

## Findings

### R1-F1 [blocker]

`executor` is a PERM field enforced by `scopeCheck` (Lane scope), but the plan only addresses `validate` (Collab handoff). A transfer commit that changes `executor` on the lane's branch will be rejected by Lane scope because PERM field changes require either (a) the trusted executor to be `claude` with only Claude sessions editing the file, or (b) a `lane_admin` lane covering the target. Neither condition holds for a self-transfer by the lane's own builder. The plan's point 6 mentions only `validate`, and the test cases in point 7 cover only the Collab handoff check.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:999` — const PERM = ['executor', 'seat', 'reviewer_seat', 'paths'];
... const permAllowed = (trustedFm.executor === 'claude' && claudeOnly) || targetOfAdmin;
if (changed.length && !permAllowed) { errors.push(...
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:384` — PR-GATE **Collab handoff** (`queue.mjs validate`, ...) checks every changed `handoff.md` / lane file ... The separate check **Lane scope** (`queue.mjs scope-check`, VTID-05213) is red on its own when a lane PR leaves its `paths`.

Suggestion: The plan must enumerate both enforcement points. `scopeCheck` needs a transfer carve-out parallel to the one proposed for `validateRange`: when the lane log contains a `transfer:` entry committed by a session that held the claim, the PERM change to `executor` (and `next_actor`) is allowed. Add scope-check transfer tests to point 7 (e.g., a kiro→claude transfer passes Lane scope when the transfer entry is present, fails without it).

### R1-F2 [blocker]

After a transfer, the PR branch contains commits from both the original builder (e.g., a kiro session) and the new builder (e.g., a Claude `session_…`). `validateRange`'s multi-builder seat check (lines 896–921) requires every builder session to be of the lane's `seat`. A Claude session's `seatOf()` returns '' which doesn't match any seat, causing a 'builder session X is not a session of the lane's seat Y' error. The plan's description of the validate change ('accepts a claim by a session of the new executor') does not describe how this multi-builder seat check is modified.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:896` — const baseFm = parseFrontMatter(showFile(repo, mergeBase, lanePath)) || fm;
const seat = baseFm.seat || '';
... else if (seatOf(s) !== seat) errors.push(`lane ${lane}: builder session ${s} is not a session of the lane's seat ${seat}`);
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:69` — export const seatOf = (s) => (/^kiro-([a-z]{1,12})-\d{12}-[0-9a-f]{4}$/.exec(s || '') || [])[1] || '';

Suggestion: Point 6 must describe the specific carve-out for the multi-builder seat check: when a `transfer:` log entry divides sessions into a before-transfer group and an after-transfer group, each group's sessions are validated against the executor that was active during their commits (kiro sessions against `seat`, Claude sessions exempted from the seat check for the post-transfer phase, or vice versa). The test cases in point 7 should include a multi-session PR with a transfer entry passing, and one without it failing.

### R1-F3 [major]

The plan cites 'lane reseat (agentic-delivery, lane_admin: true, PR #4703)' as precedent for changing permission fields. But `reseat` was a separate admin lane that changed OTHER lanes' PERM fields through the `lane_admin` mechanism. The plan proposes the lane's own builder changes the lane's own `executor` field — a fundamentally different operation. The code explicitly prevents self-administration: 'a lane never administers its own file' (scopeCheck comment at line 1010–1012). The plan should acknowledge this is a new mechanism, not an extension of the existing `lane_admin` pattern.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:1007` — // VTID-05408 (kiro-lane-admin §2): TARGET-ONLY PERM carve-out. A reviewed, trusted lane-admin lane ... may change a target lane's PERM fields. scopeCheck keys on one lane per PR, so `lanePath` is the admin lane's OWN file; a lane never administers its own file (laneAdminCovers tests `matchesAny(lanePath, trusted paths)`, and the admin lane's paths list the TARGET files, not itself), so `targetOfAdmin` is false for the admin lane's own PERM fields
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:250` — **Lane administration — the one reviewed exception to 'edit another lane's file' (kiro-lane-admin).** An authorized `executor: kiro` lane carrying `lane_admin: true` with `reviewer_seat: agent:vitana-lane-reviewer`, whose `paths` cover the target lane file, may reassign that TARGET lane's `seat`, `executor`, `reviewer_seat` and narrow its `paths`

Suggestion: Remove the `reseat` analogy or clarify that this plan introduces a new 'self-transfer' mechanism distinct from `lane_admin`. The plan should explicitly describe the new carve-out category (a builder's transfer of its own lane's executor, authenticated by holding the claim and recording a log entry) and justify its security properties against self-escalation.

### R1-F4 [major]

The plan's test list (point 7) covers only `queue.test.mjs` tests for `validateRange` (Collab handoff). It omits tests for `scopeCheck` (Lane scope), which is the primary enforcement of PERM field immutability including `executor`. Without scope-check tests, the transfer mechanism cannot be verified against the actual merge-gate enforcement.

- `exafyltd/vitana-platform:scripts/collab/queue.test.mjs:1` — // VTID-05145 — tests for scripts/collab/queue.mjs. Run: node --test scripts/collab/queue.test.mjs
import { test } from 'node:test';
...
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:946` — export function scopeCheck(repo, { base, head, branch = '', fetchLane = null, fetchPlanLane = null }) {

Suggestion: Add scope-check test cases to point 7: (g) a lane with a `transfer:` entry and changed `executor` passes Lane scope; (h) a lane with changed `executor` but no transfer entry is rejected by Lane scope; (i) a transfer entry that was not committed by the claim holder is rejected by Lane scope.

### R1-F5 [minor]

The plan references '§3, collaboration.md:157' for the rule that a session without the claim never edits the lane file. The rule is actually at line 164 in §5 ('Claim before you touch anything'), not §3 or line 157.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:158` — ## 5. Claim before you touch anything
`node <vitana-platform>/scripts/collab/queue.mjs claim <slug>/<lane-id> --session <id> --repo <repo>`
pushes `refs/heads/collab-claim/<slug>/<lane-id>` without force. ...
- A session without a claim never edits `handoff.md` or a lane file.

Suggestion: Correct the reference to §5, line 164.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
