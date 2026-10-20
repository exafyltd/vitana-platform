---
lane: retry-invalid
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: platform
reviewer_seat: jtadic
governance: true
paths:
  - scripts/collab/plan-spar.mjs
  - scripts/collab/plan-spar.test.mjs
  - services/gateway/src/services/plan-sparring/plan-sparring-service.ts
  - services/gateway/src/services/plan-sparring/plan-sparring-repository.ts
  - services/gateway/src/routes/plans-spar.ts
  - services/gateway/test/vtid-04868-plan-sparring-service.test.ts
  - docs/validation/VTID-*/**
updated: 2026-10-20T14:13Z
vtid: VTID-05262
---
# Lane: retry-invalid (repo vitana-platform)
Tasks T1–T4 in `tasks.md`. Start only after exafyltd/vitana-platform#4210 (VTID-05259, `governance: true`) is on
`main`. Until then `main`'s checker refuses this lane's `scripts/collab/**` paths. The VTID is allocated by PLAN-SPAR
on convergence.

## Log
### 2026-10-20T13:50Z · kiro-exafyltd-202610201346-3bb3 · ready
Lane created with the plan. It replaces `collab-kiro-governance/retry-partner-invalid` (VTID-05261, retired: see that
plan's handoff).

### 2026-10-20T14:13Z · ci-plan-spar · ready (VTID allocated)
VTID-05262 allocated after policy approval (converged-auto-v1).
