---
lane: verify-visual
state: ready
next_actor: kiro
depends_on: [model-config, staging-verify-wiring]
executor: kiro
seat: exafyltd
repos: [exafyltd/vitana-platform]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - scripts/ci/staging-verify/run.mjs
  - scripts/ci/staging-verify/lib.cjs
  - scripts/ci/staging-verify/lib.test.cjs
  - scripts/ci/staging-verify/visual.mjs
  - scripts/ci/staging-verify/visual.test.mjs
updated: 2026-11-11T16:49Z
vtid: VTID-05748
---

# Lane: verify-visual (repo exafyltd/vitana-platform)

Opt-in visual tests on staging: screenshots at 1400×900 and 390×844, vision verdict in `results.json`. Tasks in `tasks.md`.

## Log
### 2026-11-11T16:23Z · kiro-exafyltd-202611111044-8f1d · ready
Lane created with the plan.

### 2026-11-11T16:49Z · ci-plan-spar · ready (VTID allocated)
VTID-05748 allocated after policy approval (converged-auto-v1).
