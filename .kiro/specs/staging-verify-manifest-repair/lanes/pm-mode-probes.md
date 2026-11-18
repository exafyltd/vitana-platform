---
lane: pm-mode-probes
state: in-review
next_actor: kiro
claimed_by: kiro-exafy-202611111326-7e9b
branch: kiro/pm-mode-probes/kiro-fallback
depends_on: []
executor: kiro
seat: exafy
area: platform
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/ci/staging-verify/lib.cjs
  - scripts/ci/staging-verify/lib.test.cjs
  - docs/validation/VTID-05277/staging-tests.json
  - docs/validation/VTID-05281/staging-tests.json
  - docs/validation/VTID-*/**
updated: 2026-11-07T14:43Z
vtid: VTID-05604
---
# Lane: pm-mode-probes (repo vitana-platform)
Add `expect_json_in` to the STAGING-VERIFY runner and make the VTID-05277/05281 PM mode probes mode-agnostic without dropping what they prove.
Plan: `.kiro/specs/staging-verify-manifest-repair/plan.md` §3 and the `<!-- lane: pm-mode-probes -->` section of `tasks.md` are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here. Deploys nothing; done when the lane PR is merged with green checks and its closing records are merged. Not a protected gate file.

## Log
### 2026-11-07T14:40Z · kiro-hotmail-202611061752-cc1f · created → ready
Lane created with the plan.

### 2026-11-07T14:43Z · ci-plan-spar · ready (VTID allocated)
VTID-05604 allocated after policy approval (converged-auto-v1).

### 2026-11-13T09:00Z · kiro-exafy-202611111326-7e9b · ready → executing
Claimed. Owner decision 2026-11-11: the two mode probes expect enabled true and executor_mode kiro_fallback, the state staging is in. This replaces the plan design (expect_json_in, mode-agnostic) with the fixed owner-set value. Baseline: both probes pin claude_primary (PR 5012) and fail against staging.

### 2026-11-13T09:20Z · kiro-exafy-202611111326-7e9b · executing → in-review
Manifests VTID-05277 and VTID-05281 changed (mode probe name, expect_json, reason). Only those lines change. PR https://github.com/exafyltd/vitana-platform/pull/5061. Next: CI, then merge.
