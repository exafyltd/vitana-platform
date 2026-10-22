---
lane: preflight
state: executing
next_actor: kiro
claimed_by: kiro-202610220829-5884
branch: kiro/pipeline-speed/preflight
pr: https://github.com/exafyltd/vitana-platform/pull/4340
depends_on: []
executor: claude
seat: exafy
area: platform
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/collab/preflight.mjs
  - scripts/collab/preflight.test.mjs
  - .kiro/pipeline/lane-code.md
  - .kiro/pipeline/planning.md
  - .kiro/pipeline/driver.md
  - docs/validation/VTID-*/**
updated: 2026-10-22T19:30Z
vtid: VTID-05336
---
# preflight — every CI governance check of a lane or plan PR, locally, in one pass (item 2)
Plan: `.kiro/specs/pipeline-speed/plan.md` §2.6, D5, and the `preflight` section of `tasks.md` are authoritative.
VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here. Repo vitana-platform (the
command also checks a vitana-v1 checkout). Deploys nothing. `executor: claude` because `scripts/collab/**` is a
governance path; Kiro seat `exafy` builds it under kiro-autonomy-fallback. Spawns `queue.mjs`, `gate.mjs` and
`guard.cjs` without editing them. Protected gate files touched: none. Shared files: none.
## Log
### 2026-10-22T11:20Z · kiro-202610220829-5884 · created → ready
Lane created with the plan (owner: "yes, execute your recommendation", 2026-10-21). Next: PLAN-SPAR; once `vtid:` is
set, seat exafy claims it.

### 2026-10-22T17:50Z · ci-plan-spar · ready (VTID allocated)
VTID-05336 allocated after policy approval (converged-auto-v1).

### 2026-10-22T19:30Z · kiro-202610220829-5884 · ready → executing
Claimed (`collab-claim/pipeline-speed/preflight`), seat exafy, workflow run `wf_561cf354d2648029` slot 2, branch
`kiro/pipeline-speed/preflight`. Changed: new `scripts/collab/preflight.mjs` (spawns the Collab tests, head-copy
`queue.mjs validate`, base-copy `queue.mjs scope-check` as `PR-GATE.yml:160-166`, `gate.mjs scope|sparring|weakening|
red-green`, Kiro steering; reports every failure grouped and labelled, exit 1 on any; unchecked parts are failures)
and `scripts/collab/preflight.test.mjs` (13 tests, red on base 11/13); `lane-code.md`, `planning.md` and `driver.md`
run preflight before every push. No edit to `queue.mjs`, `gate.mjs`, `lib.mjs` or `PR-GATE.yml`. Evidence:
`docs/validation/VTID-05336/`. PR #4340 (preflight on its own head: 8/8 checks pass).
### 2026-10-22T22:15Z · agent-vitana-lane-reviewer-202610222214-8173 · review: accept
Reviewed exafyltd/vitana-platform#4340 at head `a14fcdf2c1d6d6397c6c556f81ba932f8c5fadb0` (run wf_5d72b688787bced8; read-only, no suites re-run). No blocking
findings. Non-blocking (follow-ups): none blocking; delta since the changes verdict (wf_27b4cb00217adf88, VALIDATOR-CHECK red) is docs/validation only; validate-pr green.
Stored by the land step on the agent's behalf (`lane-land.md` step 2).
Collab-Session: agent-vitana-lane-reviewer-202610222214-8173
Collab-Review: pipeline-speed/preflight
Collab-Verdict: accept
Collab-Reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
Collab-Reviewed-Head: a14fcdf2c1d6d6397c6c556f81ba932f8c5fadb0
