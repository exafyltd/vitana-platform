---
lane: runner
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: platform
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - .github/workflows/STAGING-VERIFY.yml
  - scripts/ci/staging-verify/lib.cjs
  - scripts/ci/staging-verify/lib.test.cjs
  - scripts/ci/staging-verify/run.mjs
  - docs/validation/VTID-*/**
updated: 2026-10-22T11:00Z
---
# STAGING-VERIFY runner: pinned image and allowlisted suite env (vitana-platform)
Plan: `.kiro/specs/staging-verify-runner-fix/` — `plan.md` and the `tasks.md` section `<!-- lane: runner -->`.

**Never** (collaboration §7a): no VTID allocation, no merge except §7b, no workflow dispatch except the §7a re-run
allowlist, no live write, no test against production.

## Log
### 2026-10-22T11:00Z · kiro-exafyltd-202610220818-5273 · created → ready
Lane drafted with the plan. Next: PLAN-SPAR; once CI writes the VTID, seat `exafyltd` claims it.
