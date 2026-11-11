---
lane: model-probes
state: ready
next_actor: kiro
depends_on: [model-config]
executor: kiro
seat: exafy
repos: [exafyltd/vitana-platform]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - scripts/eng/model-probe.mjs
  - scripts/eng/model-probe.test.mjs
updated: 2026-11-11T16:49Z
vtid: VTID-05742
---

# Lane: model-probes (repo exafyltd/vitana-platform)

Probe every chain model (text) and every vision model (image) from the caller's role; record tier, result and latency. Tasks in `tasks.md`.

## Log
### 2026-11-11T16:23Z · kiro-exafyltd-202611111044-8f1d · ready
Lane created with the plan.

### 2026-11-11T16:49Z · ci-plan-spar · ready (VTID allocated)
VTID-05742 allocated after policy approval (converged-auto-v1).
