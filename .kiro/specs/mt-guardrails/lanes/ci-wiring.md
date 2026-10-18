---
lane: ci-wiring
state: ready
next_actor: claude
executor: claude
reviewer_seat: hotmail
depends_on: [local-test-stack, generated-inventories, isolation-suite, gateway-scope-lint-contract, maxina-golden-suite]
paths:
  - .github/workflows/MT-GUARDRAILS.yml
  - .github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml
  - scripts/ci/mt/**
updated: 2026-10-18T16:20Z
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
adds the MIGRATION-QUEUE validator. Land report-only first via `scripts/ci/mt/config.json` `enforce`,
then flip to enforcing in a later governance change (the PR-GATE pattern). The isolation suite needs
`pgtap`/`pg_prove` **installed in the job** (pinned to the same versions the local-test-stack lane
uses) and run via `scripts/ci/sql-tests/run-mt-isolation-test.sh` against a job-local Postgres service;
wire a shrinking baseline like `check-migration-drift`.
Branch `claude/mt-guardrails/ci-wiring`; PR title `VTID-xxxxx (mt-guardrails/ci-wiring): —`; commit
trailers `Collab-Session: <session id>` and `Collab-Lane: mt-guardrails/ci-wiring`. Add this lane's own
`docs/validation/<vtid>/`.
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
