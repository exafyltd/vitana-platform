# VTID-05351 acceptance (pipeline-lane-state-efficiency/chain-transitions, tasks.md C1-C4)

Every AC maps to a TEST: within 12 lines. Raw outputs: `outputs/red-on-base.txt`, `outputs/replay-owner-autonomy.txt`.
Command log with pass/fail counts and the mutation checks: `commands.log`. Change types: Tooling/CI (governance path,
protected gate file). Deploys nothing.

AC-1 Only `scripts/collab/queue.mjs`, `scripts/collab/queue.test.mjs`, the lane file and `docs/validation/VTID-05351/**`
change. In `queue.mjs` the edge tables, `checkTransition` and every per-commit authorization rule are unchanged; the
diff adds `transitionChain` and its helpers and replaces only the transition loop body of `validateRange`.
TEST: git diff origin/main --stat; node --test scripts/collab/queue.test.mjs

AC-2 Valid chains pass: lane executing → in-review → verified → done with both merge-sha conventions, an accept entry
new in the range backed by its Collab-Review commit, the `owner/repo#N` PR reference, in-review → executing →
in-review with a changes entry, executing → parked → executing → in-review; plan executing → in-review → verified →
done with every lane done.
TEST: node --test scripts/collab/queue.test.mjs (tests "transitionChain: valid lane chains…", "…valid plan chain…")

AC-3 Invalid chains fail with their own error: skipped state, out of order, ready → done, leaving done, wrong parked
return, head parked_from mismatch, no accept entry, accept without its Collab-Review commit, accept head ≠
Collab-Reviewed-Head, no PR reference, in-review → executing without changes, verified → done without a merge sha,
rewritten base log, more than 6 edges, last edge short of the head state, first edge not at the base state.
TEST: node --test scripts/collab/queue.test.mjs (test "transitionChain: invalid chains each fail…")

AC-4 Authorization still applies inside a chain (one session per lane, claimed_by). A chain's accept/changes entry is
backed only by a review-only commit (Collab-Review, no Collab-Lane) from an authorized reviewer that is not a builder
of the range and that appended that exact entry: the builder's own trailers, an empty review commit, a Kiro-seat
reviewer and a self-review by the building Claude session are each refused; a reviewer's entry removed or copied by
the builder is refused. A single legal edge needs no new evidence.
TEST: node --test scripts/collab/queue.test.mjs (tests "validate: a closing-record PR may carry…", "validate: a chain
whose accept entry has no Collab-Review commit fails…")

AC-5 Red on base, green on head; every Collab test still passes; each safeguard is load-bearing (disabling commit
backing, merge sha, append-only, parked_from tracking, time order or the PR reference turns the suite red).
TEST: node --test scripts/collab/*.test.mjs (see commands.log and outputs/red-on-base.txt)

AC-6 Real data: owner-autonomy/v1-rules' four closing PRs (#4397, #4399, #4400, #4401) replayed as one range — refused
by origin/main, accepted by the head, refused by the head when the accept entries lack their Collab-Review commit.
TEST: node scripts/collab/queue.mjs validate --repo <replay> --base <base> --head <head> (outputs/replay-owner-autonomy.txt)

AC-7 Merge routing: `queue.mjs` is a protected gate file — merge only with a legacy Claude review on the current head or
an owner instruction naming `pipeline-lane-state-efficiency` (collaboration.md §3a).
TEST: node scripts/collab/queue.mjs scope-check (Lane scope, PR-GATE) on the PR head
