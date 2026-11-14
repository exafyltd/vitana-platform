---
lane: push
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
area: frontend
repos: [exafyltd/vitana-v1]
paths:
  - apps/mobile/tests/wave1-readiness/push/**
  - docs/validation/VTID-*/acceptance.md
  - docs/validation/VTID-*/commands.log
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/staging-tests.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-11-10T17:08Z
vtid: VTID-05683
---
# Push: lifecycle, timeout, push-open routing, test provider (mock tests, new files only)
Plan: `.kiro/specs/native-wave1-readiness-tests/` — `plan.md` (decisions 1–7) and the `tasks.md` section marked
`<!-- lane: push -->` (tasks P1–P6) are authoritative. VTID: assigned by CI after PLAN-SPAR converges.

**Goal.** New test files only under `apps/mobile/tests/wave1-readiness/push/`, mocks only, no source change, no edit to any
existing test or helper, no new dependency. A case that needs G1 is `it.skip` with `// needs G1 (isolated test backend): <reason>`
and is NOT counted toward the Wave 1 exit.

**Acceptance (reviewer agent):** the `tasks.md` Acceptance bullets of this lane; `npm test` and `npm run typecheck` pass in
`apps/mobile`; `git diff --stat origin/main` lists only the declared paths; these tests are readiness evidence only and do
not prove the Wave 1 exit, which needs G1 (`NATIVE-APP-PLAN.md` §5).

**Never:** no source edit, no edit to an existing test or helper, no network or fixture-gateway, no production host, no VTID by hand.

## Log
###  · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan.

### 2026-11-10T17:08Z · ci-plan-spar · ready (VTID allocated)
VTID-05683 allocated after policy approval (converged-auto-v1).
