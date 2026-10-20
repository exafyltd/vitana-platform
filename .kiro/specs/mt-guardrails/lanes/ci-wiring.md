---
lane: ci-wiring
state: ready
next_actor: claude
executor: claude
reviewer_seat: hotmail
depends_on: [local-test-stack, generated-inventories, isolation-suite, gateway-scope-lint-contract, maxina-golden-suite]
paths:
  - .github/workflows/MT-GUARDRAILS.yml
  - .github/workflows/SQL-MT-ISOLATION.yml
  - .github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml
  - scripts/ci/mt/**
updated: 2026-10-20T08:30Z
---
# CI wiring + MIGRATION-QUEUE check — mt-guardrails/ci-wiring (governance, repo vitana-platform)
Plan: `.kiro/specs/mt-guardrails/plan.md` (authoritative) and the `ci-wiring` section of `tasks.md`
(C1—C3, allowed paths, acceptance). Design and the rules you must follow: `design.md`.
**Governance lane.** Every path it touches (`.github/workflows/**`, `scripts/ci/**`) is a governance
path, so `executor: claude` and `next_actor: claude` — Claude Code builds it, not Kiro, and it is NOT
owner-held (collaboration §3a / §7a; the Lane scope check would reject a kiro executor here). A
Kiro seat (`hotmail`) reviews it. There is no `seat` because Kiro does not build it.
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
isolation workflow uses the plan's "Pinned versions" literals verbatim — `runs-on: ubuntu-24.04`,
service `image: supabase/postgres:17.4.1.074`, `sudo apt-get install -y
libtap-parser-sourcehandler-pgtap-perl=3.36-2` — then runs
`scripts/ci/sql-tests/run-mt-isolation-test.sh` gated by `--expect '^PASS mt-isolation'`; wire a
shrinking baseline like `check-migration-drift`.
Branch `claude/mt-guardrails/ci-wiring`; PR title `VTID-xxxxx (mt-guardrails/ci-wiring): —`; commit
trailers `Collab-Session: <session id>` and `Collab-Lane: mt-guardrails/ci-wiring`. Add this lane's own
`docs/validation/<vtid>/`.
Escalation carry-over (owner approved escalated, 2026-10-20) — R3-F1, task C0 in `tasks.md`. Acceptance: a spike
proves `supabase/postgres:17.4.1.074` boots as a GitHub Actions `service:` container and records its exact
healthcheck/env/init contract (or the adapter used) in the PR body and `docs/validation/<vtid>/`; C3 and the
workflow-shape test use that contract; the smoke test is never silently skipped when the digest check cannot run.
## Log
### 2026-10-16T21:44Z · kiro-hotmail-202610151618-b437 · created → ready
Created from the WS0 plan as a Claude governance lane: wires the five kiro lanes' checks into CI and
adds the `docs/multitenancy/MIGRATION-QUEUE.md` validator (replacing the review rule, per the queue
file's own §Notes and plan §8). Report-only first. `next_actor: claude` from creation
(governance, not owner-held).
### 2026-10-18T10:00Z · kiro-hotmail-202610151618-b437 · spar round-1 → raw-psql + row-21b fix
Prior round (accepted): `depends_on` entry `pgtap-isolation-suite` renamed to `isolation-suite`; C1/C3
no longer install or run pg_prove/pgtap — they run the raw-psql suite's `scripts/ci/test-*.sh` runner.
C-tasks fold the one-line `MORNING-SYSTEM-HEALTH-CHECK.yml` row-21b URL-binding fix.
### 2026-10-18T16:20Z · kiro-hotmail-202610151618-b437 · spar round-1 (fresh session e7f1e151) → pgTAP in CI
R1-F2 (accepted): the parent plan §4.2/§4.9 mandates pgTAP, so C1/C3 now **install `pgtap`/`pg_prove`
in the job** (pinned to the local-test-stack versions) and run the pgTAP suite via
`scripts/ci/sql-tests/run-mt-isolation-test.sh` against a job-local Postgres service — reversing the
raw-psql wording. R1-F1 (accepted): the runner path moved under `scripts/ci/sql-tests/` alongside the
VTID-05149 tenant tests. The row-21b URL-binding fix (align `SUPABASE_URL` to
`vars.DATA_REST_URL || secrets.SUPABASE_URL`) stays folded into this governance lane.
### 2026-10-18T18:40Z · kiro-hotmail-202610151618-b437 · spar round-2 → report-only path + pinned install
R2-F2 (accepted): the new checks are standalone workflows (`MT-GUARDRAILS.yml` + a dedicated
`SQL-MT-ISOLATION.yml`), NOT PR-GATE steps, so PR-GATE's `enforce` cannot gate them; each reads its own
`scripts/ci/mt/config.json` `report_only` flag (warn-and-exit-0 while true), flipped by a later
governance PR setting `report_only=false`. Added `.github/workflows/SQL-MT-ISOLATION.yml` to `paths`.
R2-F1 (accepted): the job uses lane 1's identical mechanism — pinned `supabase/postgres` image (ships
`pgtap`) + pinned `pg_prove` apt version — then runs the runner. No install divergence local↔CI.
### 2026-10-19T20:20Z · kiro-hotmail-202610151618-b437 · spar round-2 (session 496d49e4) → report-gate helper
R2-F2 (accepted): report-only is one helper, `scripts/ci/mt/report-gate.mjs` (inside `scripts/ci/mt/**`), after
every `continue-on-error` check step. R2-F1 (accepted): literal pins from the plan table. `paths` unchanged.
