---
lane: dead-workflows
state: ready
next_actor: kiro
depends_on: [speed-path-filters]
executor: claude
seat: exafyltd
reviewer_seat: claude
paths:
  - .github/workflows/VCAOP-CICD.yml
  - scripts/ci/ci-inventory/**
  - docs/validation/**
updated: 2026-10-21T12:26Z
vtid: VTID-05302
---
# Lane: dead-workflows

Remove the one genuinely-live dead GCP Cloud Run workflow (`VCAOP-CICD.yml`) with its evidence row, and
correct the inventory's dead-list to today's tracked set. Tasks T1–T3 in `tasks.md`. `executor: claude`
because it edits a governance path (`.github/**`); not a protected gate file, so it merges on a
reviewer-agent accept. No VTID yet (CI allocates on convergence).

## Log

### 2026-10-21T11:20Z · kiro-hotmail-202610210852-0b8e · ready
Lane created with the plan. Scope limited to `VCAOP-CICD.yml`, a new dead-GCP-marker inventory test, and
validation docs. Evidence from inv-code §2 (VCAOP confirmed present on origin/main a2d069ea; EXEC/STAGE-
DEPLOY already gone). No VTID yet.

### 2026-10-21T11:52Z · kiro-hotmail-202610210852-0b8e · spar s2 round-1 R1-F3 accepted
Added `depends_on: [speed-path-filters]`. VCAOP-CICD.yml is the only CI runner of the vcaop `typecheck`
(:37-39) and the run-in-band guardrails gate `test:guardrails` (:40-42); the `vcaop` entry in
TEST-SUITE.yml (:111-113) runs only `npm test`. Those two gates are migrated into TEST-SUITE.yml by lane 6
(which owns that file); this lane deletes `VCAOP-CICD.yml` only after lane 6 has landed them, so no gate is
silently lost. Paths unchanged (TEST-SUITE.yml stays owned by lane 6).

### 2026-10-21T12:26Z · ci-plan-spar · ready (VTID allocated)
VTID-05302 allocated after policy approval (converged-auto-v1).
