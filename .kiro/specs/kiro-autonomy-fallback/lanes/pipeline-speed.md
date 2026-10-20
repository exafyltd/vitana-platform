---
lane: pipeline-speed
state: ready
next_actor: kiro
depends_on: []
executor: claude
seat: exafy
area: platform
reviewer_seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/collab/plan-driver.mjs
  - scripts/collab/plan-driver.test.mjs
  - .github/workflows/TEST-SUITE.yml
  - .github/workflows/TEST-SUITE-RERUN.yml
  - .github/workflows/CI-SCRIPTS-TEST.yml
  - .github/workflows/PLAN-SPAR.yml
  - scripts/ci/test-suite/**
  - scripts/ci/plan-spar-slot/**
  - scripts/ci/staging-verify/run.mjs
  - scripts/ci/staging-verify/lib.cjs
  - scripts/ci/staging-verify/lib.test.cjs
  - services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts
  - docs/validation/VTID-*/**
updated: 2026-10-20T17:49Z
vtid: VTID-05272
---
# pipeline-speed — continuous plan driver, Jest shards, PLAN-SPAR slots, per-lane STAGING-VERIFY attribution, unblock main
Plan: `.kiro/specs/kiro-autonomy-fallback/plan.md` §4.7, §7 and §5 H, and the `pipeline-speed` section of `tasks.md` are
authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here. Repo
vitana-platform. **Deploys** (gateway test file, H0): ships `docs/validation/<VTID>/staging-tests.json`.
PM speed items (timers, ticks, Gate 2, plan( auto-merge, serialized landing, timings) are folded into `pm-fallback`;
open-plan-PR lane scope into `scope-check`; automation cadence into `exceptions-seat` (file ownership, plan §7).
`plan-driver.mjs` imports from `queue.mjs` without editing it.
**Bootstrap (plan §6):** `executor: claude` is the value today's validator requires for `.github/**` and
`scripts/collab/**`; Kiro seat `exafy` builds it under the owner's §7b instruction. Acceptance by
`agent:vitana-lane-reviewer (claude-sonnet-5.5)`; review entry committed under the legacy `reviewer_seat` exafyltd.
Protected gate file touched: `.github/workflows/PLAN-SPAR.yml` (one step; owner instruction, plan §6). safe-merge refuses
workflow files, so the PM never merges this lane; it lands under §7b. Shared files: none.
## Log
### 2026-10-20T17:20Z · kiro-exafyltd-202610201618-c018 · created → ready
Owner instruction 2026-10-20: "no more approvals, you run it end to end" and "remove the waits, parallel by default,
measurement" — §7b merge instruction for this plan's named set, approvals from the reviewer agent on claude-sonnet-5.5;
lands after `steering-rules`. Lane created with the plan. Next: PLAN-SPAR; once `vtid:` is set, seat exafy claims it.

### 2026-10-20T17:49Z · ci-plan-spar · ready (VTID allocated)
VTID-05272 allocated after policy approval (converged-auto-v1).
