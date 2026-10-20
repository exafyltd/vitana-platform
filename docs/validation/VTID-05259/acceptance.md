# VTID-05259 — acceptance (retire-claude-code/scope-rules)

Lane `retire-claude-code/scope-rules`: `scripts/collab/queue.mjs` lets Kiro seats do governance work without Claude
Code. Plan: `.kiro/specs/retire-claude-code/` (PLAN-SPAR converged, policy approval).

AC-1 A Kiro lane may declare or change a governance path only with `governance: true`, a `seat` and a different Kiro `reviewer_seat` (never `claude`).
TEST: node --test scripts/collab/queue.test.mjs — "VTID-05259 validateLane", "VTID-05259 scope-check: a governance lane may change governance paths"

AC-2 On a governance lane, build commits name the lane seat, review entries name reviewer_seat; unseated and session_ ids are refused; a review commit changes only the lane file; `_plan` commits are exempt only for spec-folder files.
TEST: node --test scripts/collab/queue.test.mjs — "VTID-05259 scope-check: a governance lane may change …", "VTID-05259 review fixes: _plan and review commits cannot carry code …"

AC-3 No lane PR changes a lane's permissions (incl. `governance`, and incl. session_ ids on executor: claude lanes); legacy executor: claude lanes no longer reach governance paths; new executor: claude lanes are refused.
TEST: node --test scripts/collab/queue.test.mjs — "VTID-05259 scope-check: a lane PR cannot make itself a governance lane …", "VTID-05213 review: a lane PR cannot widen its own permissions …", "scope-check: a governance path inside paths needs governance: true …"

AC-4 A lane new in the PR grants no paths, except non-governance paths of a lane in a new plan that PLAN-SPAR's own commit approved in the same PR; a vitana-v1 PR cannot shadow a platform lane; ghFetcher fails closed except on 404.
TEST: node --test scripts/collab/queue.test.mjs — "VTID-05259 round 3: governance lanes only inside the approved plan …", "VTID-05259 review fixes: … v1 cannot shadow a platform lane"

AC-5 A new governance lane is created only by the author seat of a new plan, present in the tree of PLAN-SPAR's own approving commit.
TEST: node --test scripts/collab/queue.test.mjs — "VTID-05259 round 2: …", "VTID-05259 round 3: …", "VTID-05259 round 4: approval is PLAN-SPAR's own commit …"

AC-6 A governance lane reaches verified only with a new quoted owner-instruction line, and done only with a new merge line naming a commit on base (or verified in the other repo) whose message names the lane and that changes the lane's paths.
TEST: node --test scripts/collab/queue.test.mjs — "VTID-05259 governanceRecord …", "VTID-05259 validate: a governance lane reaches verified …", "VTID-05259 round 2: merge must be on base …", "VTID-05259 round 5: the merge commit must change one of the lane's paths"

AC-7 Existing behaviour unchanged except the two contracts named in the PR body; 0 tests removed.
TEST: node --test scripts/collab/queue.test.mjs — all 43 pass; the 30 pre-existing tests (2 with an intentionally changed contract) pass
