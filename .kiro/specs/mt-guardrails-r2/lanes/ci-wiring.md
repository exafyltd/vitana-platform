---
lane: ci-wiring
state: ready
next_actor: kiro
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
depends_on: [local-test-stack-pglite, generated-inventories, isolation-suite, gateway-scope-lint-contract, maxina-golden-suite]
paths:
  - .github/workflows/MT-GUARDRAILS.yml
  - .github/workflows/SQL-MT-ISOLATION.yml
  - .github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml
  - scripts/ci/mt/**
updated: 2026-11-08T14:23Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05443
---
# CI wiring + MIGRATION-QUEUE check — mt-guardrails-r2/ci-wiring (governance, repo vitana-platform)
Plan: `.kiro/specs/mt-guardrails-r2/plan.md` (authoritative) and the `ci-wiring` section of `tasks.md`
(C1—C3, allowed paths, acceptance). Design and the rules you must follow: `design.md`.
**Governance lane.** Every path it touches (`.github/workflows/**`, `scripts/ci/**`) is a governance path and none
is a protected gate file, so on today's rules (collaboration §3a) it is `executor: kiro`, seat `hotmail`, accepted by
the reviewer agent.
Depends on all five kiro lanes being `done` — it wires the commands they produce (inventory/lint
generators, the pgTAP isolation suite, gateway scope lint, contract tests, golden suite) into CI and
adds the MIGRATION-QUEUE validator. **Report-only path (R2-F2, path B):** the new checks are standalone
workflows (`MT-GUARDRAILS.yml` for the non-SQL checks; a dedicated `SQL-MT-ISOLATION.yml` for the pgTAP
suite, modelled on `SQL-TENANT-FOUNDATION.yml` with `paths:` on `scripts/ci/sql-tests/**`), so they are
NOT gated by PR-GATE's `scripts/ci/pr-gate/config.json` `enforce` (that flag only governs the Verdict
`OUTCOMES` checks — scope/kiro-steering/sparring/weakening/red-green). Each new workflow reads its OWN
`scripts/ci/mt/config.json` `{ "report_only": true }` through ONE helper, `scripts/ci/mt/report-gate.mjs`:
each check step has an `id:` + `continue-on-error: true`, followed by an `if: always()` step
`node scripts/ci/mt/report-gate.mjs --outcome "${{ steps.<id>.outcome }}" [--log <file> --expect '<regex>']`
(pass → 0; fail + `true` → `::warning` + 0; fail + `false` → `::error` + 1; missing/invalid config → 1).
`report-gate.test.mjs` covers those cases; a workflow-shape test asserts the step pairing and the pinned
literals. The flip to enforcing is a later governance PR setting `report_only` to `false`. The pgTAP
isolation workflow starts the stack the way developers do (plan R3-F1): `runs-on: ubuntu-24.04`, no `services:`
block, a step running lane 1's `scripts/mt/stack/up.sh` and `replay.sh` (pinned image), `sudo apt-get install -y
libtap-parser-sourcehandler-pgtap-perl=3.36-2`, then runs
`scripts/ci/sql-tests/run-mt-isolation-test.sh` gated by `--expect '^PASS mt-isolation'`; wire a
shrinking baseline like `check-migration-drift`.
Branch `kiro/mt-guardrails-r2/ci-wiring`; PR title `VTID-xxxxx (mt-guardrails-r2/ci-wiring): —`; commit
trailers `Collab-Session: <session id>` and `Collab-Lane: mt-guardrails-r2/ci-wiring`. Add this lane's own
`docs/validation/<vtid>/`.
Re-plan answer R3-F1 (task C0 in `tasks.md`): the first workflow step boots the pinned image through `up.sh` and
fails loudly if it does not come up; no `services:` container, no silently skipped smoke step.

## Log
### 2026-11-01T15:30Z · kiro-hotmail-202611011402-f523 · ready
Lane created with the re-plan `mt-guardrails-r2` (carried from `mt-guardrails`).

### 2026-11-01T17:06Z · ci-plan-spar · ready (VTID allocated)
VTID-05443 allocated after policy approval (converged-auto-v1).

### 2026-11-08T14:23Z · kiro-hotmail-202611061752-cc1f · ready (depends_on repointed)
`depends_on` changed from `local-test-stack` to `local-test-stack-pglite` (VTID-05520, done) per plan.md Amendment 2, decision 1 and its Consequences. `local-test-stack` (VTID-05447) and `local-test-stack-v2` (VTID-05469) are parked as superseded (PRs #4881, #4882). No other change.

### 2026-11-08T14:46Z · agent-vitana-lane-reviewer-202611081442-6833 · review
review: accept
head: a918b7cfa5855fb71c9850d5a1b988b65aaea0d6
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4901
Findings: none blocking. The single changed file is the lane file. depends_on local-test-stack → local-test-stack-pglite matches plan.md Amendment 2 on origin/main, where the dependency "now means local-test-stack-pglite". local-test-stack-pglite is done (VTID-05520, merge 932da573be), and local-test-stack is parked as superseded. The other four dependencies, paths, state, executor, seat and vtid are unchanged, and the log entry is appended. Trailers are correct, the identity is kiro-agent[bot], and no protected gate file is touched. Non-blocking: the PR is behind main (merge-base e9168deed9, main 4294d5cd57; no spec files differ), so the land step must update it and re-check before merging. Check runs and queue.mjs validate on this head were not readable from this role, so land-guard must confirm every required check is green. The log cites PRs #4881 and #4882; these were not checked against GitHub.
Next: the land step merges under §7b once land-guard confirms the PR is up to date and every check is green on the current head
