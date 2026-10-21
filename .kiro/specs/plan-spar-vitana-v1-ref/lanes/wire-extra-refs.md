---
lane: wire-extra-refs
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
area: platform
reviewer_seat: jtadic
paths:
  - scripts/collab/plan-spar.mjs
  - scripts/collab/plan-spar.test.mjs
  - .github/workflows/PLAN-SPAR.yml
  - .kiro/specs/plan-spar-vitana-v1-ref/**
updated: 2026-10-21T11:21Z
vtid: VTID-05299
---
# Lane: wire-extra-refs (repo vitana-platform)

Tasks T1–T6 in `tasks.md`. The VTID is allocated by PLAN-SPAR on convergence (policy
`converged-auto-v1`). **Governance-path lane** — it intentionally touches `scripts/collab/**` and
`.github/workflows/PLAN-SPAR.yml`, which the PR-GATE **Lane scope** check expects from an
`executor: claude`-class change; it is built in the Stage A governance lane authorized for them.

## Log

### 2026-10-15T22:03Z · kiro-202610152203-0347 · ready
Lane created with the plan. Declares the only lane of `plan-spar-vitana-v1-ref`: wire a per-plan
companion `vitana-v1` ref (`spar_refs:` in `handoff.md`) into PLAN-SPAR via `plan-spar.mjs`
(`parseSparRefs`, `resolveRef`, `extra_refs`), one `env:` line in `PLAN-SPAR.yml`, and the unit tests.
Held at `next_actor: claude` until PLAN-SPAR allocates the VTID on policy approval.

### 2026-10-21T11:21Z · ci-plan-spar · ready (VTID allocated)
VTID-05299 allocated after policy approval (converged-auto-v1).
