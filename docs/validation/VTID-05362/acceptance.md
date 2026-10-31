# VTID-05362 acceptance (step-order-gate/land-guard, tasks.md T1-T4)

Every AC below is checked by the reviewer agent against the PR diff. Each maps to a TEST: within 12 lines.

AC-1 `evidence` refuses until acceptance.md, commands.log and scope.json are staged or committed.
TEST: node --test scripts/collab/land-guard.test.mjs

AC-2 `review` accepts only the current head, entry-only lane-file commits, or pm-agent lane-state commits after the
reviewed head. `checks` uses the latest attempt per check, never passes on zero checks, and returns 2 while pending.
TEST: node --test scripts/collab/land-guard.test.mjs

AC-3 `merge` refuses a stale review, red or pending checks, a PR behind its base, or a protected gate file, and only
then calls the merge API.
TEST: node --test scripts/collab/land-guard.test.mjs

AC-4 `release` / `release-heartbeat` read origin/main and refuse until the lane (or, for _plan and the heartbeat, the
plan and every lane) is done or parked, leaving the refs in place. common-rules.md rule 13 and lane-land.md 3d/3f use
land-guard.
TEST: node --test scripts/collab/*.test.mjs
