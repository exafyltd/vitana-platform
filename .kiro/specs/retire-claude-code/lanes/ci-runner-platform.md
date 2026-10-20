---
lane: ci-runner-platform
state: ready
next_actor: kiro
depends_on: [scope-rules]
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: jtadic
governance: true
paths:
  - .github/workflows/ANDROID-DEVICE-E2E.yml
  - .github/workflows/E2E-ORB-MONITOR.yml
  - .github/workflows/E2E-TEST-RUN.yml
  - .github/workflows/MOBILE-DEVICE-E2E.yml
  - .github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml
  - .github/workflows/SCREEN-LOAD-TIMING.yml
  - .github/workflows/STAGING-TESTS-REQUIRED.yml
  - .github/workflows/STAGING-VERIFY-NIGHTLY.yml
  - .github/workflows/STAGING-VERIFY.yml
  - .github/workflows/VISUAL-VERIFY-FRONTEND.yml
  - .github/workflows/PR-GATE.yml
  - scripts/ci/playwright-runner-pin.test.mjs
  - docs/validation/VTID-*/**
updated: 2026-10-20T10:51Z
vtid: VTID-05255
---
# Pin Playwright jobs to ubuntu-24.04 (platform)
Plan: `.kiro/specs/retire-claude-code/` — `plan.md` and the `tasks.md` section `<!-- lane: ci-runner-platform -->` are
authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.
**Governance lane:** merge only on the owner's explicit per-PR instruction and an approving review from seat `jtadic` on the current head; never from an automation run.

## Log
### 2026-10-20T10:45Z · kiro-exafyltd-202610201041-ab5d · created → ready
Lane drafted with the plan. Next: PLAN-SPAR; once `vtid:` is set, seat exafyltd claims it.

### 2026-10-20T10:51Z · ci-plan-spar · ready (VTID allocated)
VTID-05255 allocated after policy approval (converged-auto-v1).
