---
lane: false-positives-validator
state: executing
next_actor: kiro
depends_on: []
executor: claude
seat: exafyltd
reviewer_seat: claude
claimed_by: kiro-202610211348-9f71
branch: kiro/ci-github-modernization/false-positives-validator
pr: https://github.com/exafyltd/vitana-platform/pull/4256
paths:
  - .github/workflows/VALIDATOR-CHECK.yml
  - .github/pull_request_template.md
  - .github/PULL_REQUEST_TEMPLATE/**
  - scripts/ci/validator-path-guard.cjs
  - scripts/ci/validator-path-guard.test.cjs
  - docs/validation/**
updated: 2026-10-21T14:40Z
vtid: VTID-05305
---
# Lane: false-positives-validator

Make the `VALIDATION_PROFILE` round-trip a template / autofill / clear early failure: add a PR body
template carrying the profile + required markers, and make `VALIDATOR-CHECK.yml` /
`scripts/ci/validator-path-guard.cjs` fail early with a precise, actionable message instead of a bare
`exit 11`. Tasks T1–T3 in `tasks.md`. `executor: claude` (governance `.github/**` + `scripts/ci/**`;
**not** a protected gate file → merges on a reviewer-agent accept). Trigger stays path-scoped to the
gateway trees (no new PR types bitten). No VTID yet.

## Log

### 2026-10-21T11:20Z · kiro-hotmail-202610210852-0b8e · ready
Lane created with the plan. Scope: VALIDATOR-CHECK.yml, a PR template, the validator-path-guard + its
test, validation docs. Evidence from inv-rules §6-7 / inv-code §3 / inv-tests §2-3. No VTID yet.

### 2026-10-21T12:26Z · ci-plan-spar · ready (VTID allocated)
VTID-05305 allocated after policy approval (converged-auto-v1).

### 2026-10-21T14:40Z · kiro-202610211348-9f71 · executing
Claimed and implemented (slot 4). T1: added `.github/pull_request_template.md` carrying
`VALIDATION_PROFILE` + the four markers (SCOPE_ALLOWLIST / ACCEPTANCE / MERGE_PAYLOAD_PREVIEW /
OASIS_IMPACT) with guidance. T2: added `prBodyRequirements(body)` + a `--pr-body-check` CLI to
`scripts/ci/validator-path-guard.cjs` that reports every missing declaration at once with its fix,
preserving the historic exit codes (11/12/13/14/15 = first missing item); rewired `VALIDATOR-CHECK.yml`
to call it as an early "Require PR body declarations" step and removed the bare `exit 11` dependence and
the separate inline "Require PR markers" step. T3: added `scripts/ci/validator-path-guard.test.cjs`
(node:test, 6 cases) — green on head, red on the origin/main module (`prBodyRequirements` absent).
REMIT == workflow `paths:` invariant still holds (gateway TS test unaffected). Evidence under
`docs/validation/VTID-05305/`.

Decision (impl-notes): left `scripts/ci/validate-pr-locally.cjs` (a local-dev mirror of the workflow,
out of this lane's paths) unchanged — it still reuses the guard module and is not CI-enforced. Noted for
a possible follow-up so its inline marker messages match the new consolidated one.
