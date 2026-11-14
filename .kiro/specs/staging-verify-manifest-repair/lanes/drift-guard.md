---
lane: drift-guard
state: in-review
next_actor: kiro
claimed_by: kiro-exafy-202611111326-7e9b
branch: kiro/staging-verify-manifest-repair/drift-guard
depends_on: [console-probes-a, console-probes-b, ref-05331, shadow-retired]
executor: kiro
seat: exafy
area: platform
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/ci/staging-verify/manifest-drift.test.cjs
  - .github/workflows/STAGING-TESTS-REQUIRED.yml
  - docs/validation/VTID-*/**
updated: 2026-11-07T14:43Z
vtid: VTID-05602
---
# Lane: drift-guard (repo vitana-platform)
A CI test that reads every gateway/community-app manifest against the tree it describes, run in STAGING-TESTS-REQUIRED.
Plan: `.kiro/specs/staging-verify-manifest-repair/plan.md` §3 and the `<!-- lane: drift-guard -->` section of `tasks.md` are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here. Deploys nothing; done when the lane PR is merged with green checks and its closing records are merged. Not a protected gate file.

## Log
### 2026-11-07T14:40Z · kiro-hotmail-202611061752-cc1f · created → ready
Lane created with the plan.

### 2026-11-07T14:43Z · ci-plan-spar · ready (VTID allocated)
VTID-05602 allocated after policy approval (converged-auto-v1).

### 2026-11-11T20:00Z · kiro-exafy-202611111326-7e9b · ready → executing
Claimed. Dependencies console-probes-a, console-probes-b, ref-05331, shadow-retired are merged (#4975, #4976, #4986, #4992). Evidence in docs/validation/VTID-05602/.
pr: https://github.com/exafyltd/vitana-platform/pull/4993

### 2026-11-11T21:10Z · kiro-exafy-202611111326-7e9b · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4993. Preflight every check passed. CI is red by design until staging-manifest-remainder lands (four manifests).
