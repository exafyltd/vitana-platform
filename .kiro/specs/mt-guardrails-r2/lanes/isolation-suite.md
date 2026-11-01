---
lane: isolation-suite
state: ready
next_actor: kiro
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
depends_on: [local-test-stack, generated-inventories]
paths:
  - scripts/ci/sql-tests/mt-isolation.test.sql
  - scripts/ci/sql-tests/run-mt-isolation-test.sh
updated: 2026-11-01T17:06Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05446
---
# Isolation suite (pgTAP) — mt-guardrails-r2/isolation-suite (repo vitana-platform)
Plan: `.kiro/specs/mt-guardrails-r2/plan.md` (authoritative) and the `isolation-suite` section of
`tasks.md` (P1—P3, allowed paths, acceptance). Design and the rules you must follow: `design.md`.
VTIDs come from PLAN-SPAR on convergence; never by hand. Depends on
`local-test-stack` (the suite runs against its seeded, running local stack — the pinned
`supabase/postgres` image that ships `pgtap`, plus the pinned `pg_prove`, R2-F1) and
`generated-inventories` (for the shared health-table-list constant).
Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of
`handoff.md`, no merge/approve/deploy/workflow dispatch, no live-system writes. The suite only ever
touches the local stack — it is read-only against production by construction (rules 31/48). It uses
**pgTAP**, which the hash-stamped parent program plan mandates for exactly these assertions
(`docs/MULTI-TENANT-PLAN.md` §4.2 at `:51` and §4.9 at `:61`; parent plan-body hash
`869182cc6aef344b107c6a8915fe2271bbd1bc982febb198f09027e7eb451326` at `:1`). This spec is the first
introduction of pgTAP into the repo — path (a) from sparring round 1; the parent already assumed WS0
would introduce it, so no parent amendment is made (R1-F2). The runner invokes `pg_prove` over
**external `psql`** against lane 1's running stack (NOT `initdb`/`pg_ctl`). Both the spec
(`scripts/ci/sql-tests/mt-isolation.test.sql`) and the runner
(`scripts/ci/sql-tests/run-mt-isolation-test.sh`) live in `scripts/ci/sql-tests/`, exactly as the
VTID-05149 analogue co-locates `vtid-05149-tenant-foundation.test.sql` with
`run-tenant-foundation-test.sh`, so `SQL-MT-ISOLATION.yml`'s `paths:` uses the `scripts/ci/sql-tests/**`
glob like `SQL-HEALTH-STORE.yml`/`SQL-MEMORY-SENSITIVITY.yml` (not `SQL-TENANT-FOUNDATION.yml`'s file list).
The runner MUST start with the PGHOST guard copied from `run-tenant-foundation-test.sh:18-20`
(`*supabase*|*amazonaws*|*rds*` → exit 2), runs under `set -euo pipefail`, and prints
`PASS mt-isolation` as its last line only after `pg_prove` exits 0 — the marker `ci-wiring`'s
`report-gate.mjs --expect '^PASS mt-isolation'` checks. For the health tables
use the shared health-table-list constant from `generated-inventories` (switching to mt-identity's
`isHealthTable()` when it ships), never a scattered local copy (CROSS-SPEC O1). Work only inside the
allowed paths; add this lane's own `docs/validation/<vtid>/`.
Branch `kiro/mt-guardrails-r2/isolation-suite`; PR title `VTID-xxxxx
(mt-guardrails-r2/isolation-suite): —`; commit trailers `Collab-Session: <your kiro session id>` and
`Collab-Lane: mt-guardrails-r2/isolation-suite`. When the PR is open: set `state: in-review`,
`next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T15:30Z · kiro-hotmail-202611011402-f523 · ready
Lane created with the re-plan `mt-guardrails-r2` (carried from `mt-guardrails`).

### 2026-11-01T17:06Z · ci-plan-spar · ready (VTID allocated)
VTID-05446 allocated after policy approval (converged-auto-v1).
