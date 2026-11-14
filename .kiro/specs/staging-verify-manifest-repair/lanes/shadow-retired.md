---
lane: shadow-retired
state: parked
next_actor: kiro
branch: kiro/staging-verify-manifest-repair/shadow-retired
depends_on: []
executor: kiro
seat: exafyltd
area: platform
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - docs/validation/VTID-04784/staging-tests.json
  - docs/validation/VTID-05007/staging-tests.json
  - docs/validation/VTID-*/**
updated: 2026-11-13T18:49Z
vtid: VTID-05606
parked_from: in-review
---
# Lane: shadow-retired (repo vitana-platform)
Retire only the deleted recall-shadow jest path from VTID-04784 and VTID-05007, with the VTID-05556 evidence, and point 04784 at the surviving recall test.
Plan: `.kiro/specs/staging-verify-manifest-repair/plan.md` §3 and the `<!-- lane: shadow-retired -->` section of `tasks.md` are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here. Deploys nothing; done when the lane PR is merged with green checks and its closing records are merged. Not a protected gate file.

## Log
### 2026-11-07T14:40Z · kiro-hotmail-202611061752-cc1f · created → ready
Lane created with the plan.

### 2026-11-07T14:43Z · ci-plan-spar · ready (VTID allocated)
VTID-05606 allocated after policy approval (converged-auto-v1).

### 2026-11-11T18:40Z · kiro-exafy-202611111326-7e9b · ready → executing
Claimed. Evidence in docs/validation/VTID-05606/. Source: PR #4964 (its VTID-04784 part).
pr: https://github.com/exafyltd/vitana-platform/pull/4992

### 2026-11-11T19:10Z · kiro-exafy-202611111326-7e9b · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4992. Preflight every check passed.
### 2026-11-12T20:17Z · pm-agent · update
reassign review agent:vitana-lane-reviewer→exafyltd (stale_review, Claude unavailable)
### 2026-11-13T18:49Z · pm-agent · in-review → parked
park (stale_claim); claim released; Claude unavailable → exafyltd
