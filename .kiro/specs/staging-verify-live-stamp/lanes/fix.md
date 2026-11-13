---
lane: fix
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
  - scripts/ci/staging-verify/workflow.test.cjs
  - docs/validation/VTID-*/**
updated: 2026-11-13T17:55Z
vtid: VTID-05798
---
# STAGING-VERIFY resolves the live-served commit when commit_sha is omitted (vitana-platform)
Plan: `.kiro/specs/staging-verify-live-stamp/` — `plan.md` and the `tasks.md` section `<!-- lane: fix -->`.

**Never** (collaboration §7a): no VTID allocation, no merge except §7b, no workflow dispatch except the §7a re-run
allowlist, no live write, no test against production.

## Log
### 2026-11-13T17:37Z · kiro-exafyltd-202611131736-78e6 · created → ready
Lane drafted with the plan. Code already written in this session (F1–F4 of `tasks.md`): `commit_sha` is now
optional, the live-stamp lookup runs via the existing `run.mjs stamp` when it's omitted, and
`workflow.test.cjs` has new static + behavioral cases (extract-and-execute the real step script with a fake `node`)
proving the lookup fires only when `commit_sha` is omitted and never otherwise. Verified locally: the new/changed
cases fail against `main` (pre-fix) and pass against this lane's branch; the full `scripts/ci/staging-verify`
suite (135 cases) is green; the edited YAML parses with `js-yaml`.
Next: PLAN-SPAR spars the plan; once CI allocates this lane's VTID, record it here and open/update the PR
(`kiro/staging-verify-live-stamp/fix`), then hand to the reviewer agent.

### 2026-11-13T17:55Z · ci-plan-spar · ready (VTID allocated)
VTID-05798 allocated after policy approval (converged-auto-v1).
