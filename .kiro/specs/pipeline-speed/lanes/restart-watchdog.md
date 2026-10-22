---
lane: restart-watchdog
state: in-review
next_actor: kiro
depends_on: []
executor: claude
seat: exafy
claimed_by: kiro-202610220829-5884
branch: kiro/pipeline-speed/restart-watchdog
pr: https://github.com/exafyltd/vitana-platform/pull/4337
area: platform
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - .kiro/hooks/vitana-workflow-watchdog.json
  - scripts/collab/workflow-watchdog.mjs
  - scripts/collab/workflow-watchdog.test.mjs
  - .kiro/pipeline/restart-watchdog.md
  - .kiro/pipeline/README.md
  - docs/validation/VTID-*/**
updated: 2026-10-22T20:49Z
vtid: VTID-05337
---
# restart-watchdog — workflow runs paused by an agent restart are surfaced at session start (item 4)
Plan: `.kiro/specs/pipeline-speed/plan.md` §2.8, D7, and the `restart-watchdog` section of `tasks.md` are
authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here. Repo
vitana-platform. Deploys nothing. `executor: claude` because `scripts/collab/**` is a governance path; Kiro seat
`exafy` builds it under kiro-autonomy-fallback. Read-only: the hook reports and instructs, it never writes engine
state. `.kiro/hooks/vitana-pipeline-start.json` stays unchanged. Protected gate files touched: none. Shared files: none.
## Log
### 2026-10-22T11:20Z · kiro-202610220829-5884 · created → ready
Lane created with the plan (owner: "yes, execute your recommendation", 2026-10-21). Next: PLAN-SPAR; once `vtid:` is
set, seat exafy claims it.

### 2026-10-22T17:50Z · ci-plan-spar · ready (VTID allocated)
VTID-05337 allocated after policy approval (converged-auto-v1).
### 2026-10-22T18:45Z · kiro-202610220829-5884 · ready → executing
Claimed (collab-claim ref), worktree on origin/main 1d5cfda68. Built W1-W4: `scripts/collab/workflow-watchdog.mjs`,
`scripts/collab/workflow-watchdog.test.mjs` (12 tests, red on base 9/12, green 12/12), `.kiro/hooks/vitana-workflow-watchdog.json`,
`.kiro/pipeline/restart-watchdog.md`, one README line. Evidence: `docs/validation/VTID-05337/`. PR #4337.
### 2026-10-22T19:25Z · kiro-202610220829-5884 · executing (review follow-ups)
Review follow-ups of the first accept (agent:vitana-lane-reviewer (claude-opus-5.5), run
wf_58eeea0f0ba61b49, head `75287232e50c05fa9bbb0fc726dc10ead231d423`, 0 blocking) fixed in `8f0f912b9`: (2) the
uncited engine claim about resuming another session's run now cites the engine sweep events, (3) the stale-run
wording no longer asserts the engine instance is gone and cites `staleAfterMs` / `workflow.sweep.reconciling_stale_run`.
(1) VALIDATOR-CHECK: `acceptance.md` + `outputs/` added and the PR body gains the validator markers. `origin/main`
merged in (`64df919a3`). Re-review requested on the new head.
### 2026-10-22T20:25Z · agent-vitana-lane-reviewer-202610222025-caf7 · review: accept
Reviewed exafyltd/vitana-platform#4337 at head `5582f108e61e411aea0387f3a89fce78948998f7` (run wf_91efeebdbdd1db37; read-only, no suites re-run). No blocking
findings. Non-blocking (follow-ups): 5 non-blocking findings recorded in reviewer run wf_91efeebdbdd1db37 (relayed by the parent; CI was still queued at review time, now green on this head).
Stored by the land step on the agent's behalf (`lane-land.md` step 2).
Collab-Session: agent-vitana-lane-reviewer-202610222025-caf7
Collab-Review: pipeline-speed/restart-watchdog
Collab-Verdict: accept
Collab-Reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
Collab-Reviewed-Head: 5582f108e61e411aea0387f3a89fce78948998f7
### 2026-10-22T20:49Z · kiro-202610220829-5884 · executing → in-review
merge: ee0c731aa52168378729ef546c685f36c4f97afe · authority: §7b PM rule (owner instruction 2026-10-21: "yes, execute your recommendation", "now you can run fully end to end without stopping"). exafyltd/vitana-platform#4337 squash-merged 2026-10-22T20:47:29Z. Reviewer accept: agent:vitana-lane-reviewer (claude-opus-5.5) on `5582f108e61e411aea0387f3a89fce78948998f7` (run wf_91efeebdbdd1db37; first accept wf_58eeea0f0ba61b49 on `75287232e`), entry-only commit `928302667`, then `gh pr update-branch` (main's commits only, `34cf5931b`). All 10 checks green (validate, Collab handoff, Lane scope, validate-pr incl.), no `--admin`. The lane could not be `verified` before the merge: Collab handoff allows one state edge per PR against `main` (`ready → executing` here), so the edges follow as closing records.
Follow-ups (non-blocking): the second review's 5 non-blocking findings (run wf_91efeebdbdd1db37); the engine run-folder layout stays version-sensitive (documented in `restart-watchdog.md`). Next: verified (one edge per PR).
