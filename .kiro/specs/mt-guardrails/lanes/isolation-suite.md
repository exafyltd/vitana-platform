---
lane: isolation-suite
state: ready
next_actor: owner
executor: kiro
seat: hotmail
reviewer_seat: exafy
depends_on: [local-test-stack, generated-inventories]
paths:
  - scripts/ci/sql-tests/mt-isolation.test.sql
  - scripts/ci/sql-tests/run-mt-isolation-test.sh
updated: 2026-10-19T20:20Z
---
# Isolation suite (pgTAP) — mt-guardrails/isolation-suite (repo vitana-platform)
Plan: `.kiro/specs/mt-guardrails/plan.md` (authoritative) and the `isolation-suite` section of
`tasks.md` (P1—P3, allowed paths, acceptance). Design and the rules you must follow: `design.md`.
`next_actor: owner` is HELD: it flips to `kiro` when PLAN-SPAR allocates this lane's VTID. Depends on
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
Branch `kiro/mt-guardrails/isolation-suite`; PR title `VTID-xxxxx
(mt-guardrails/isolation-suite): —`; commit trailers `Collab-Session: <your kiro session id>` and
`Collab-Lane: mt-guardrails/isolation-suite`. When the PR is open: set `state: in-review`,
`next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.
## Log
### 2026-10-16T21:44Z · kiro-hotmail-202610151618-b437 · created → ready
Created from the WS0 plan. Asserts b_member reads 0 T_A rows on the 18 tenant tables + the health tables
and that cross-tenant writes fail. Held at `next_actor: owner` until the VTID is allocated.
### 2026-10-18T10:00Z · kiro-hotmail-202610151618-b437 · spar round-1 → raw-psql
Renamed from `pgtap-isolation-suite` to `isolation-suite` (prior round, accepted): the suite uses the
repo's existing raw-psql + RAISE harness, not pgTAP/`pg_prove` (none exists in the repo). Paths changed
from `scripts/mt/pgtap/**` to `scripts/ci/test-mt-isolation.sh`; added `depends_on: generated-inventories`
for the shared health-table-list constant.
### 2026-10-18T16:20Z · kiro-hotmail-202610151618-b437 · spar round-1 (fresh session e7f1e151) → pgTAP reinstated
Round 1 reversed the raw-psql decision. R1-F2 (accepted): the hash-stamped parent plan §4.2 (`:51`) and
§4.9 (`:61`) explicitly MANDATE pgTAP for these exact isolation assertions (parent hash
`869182cc…51326`); a sub-plan cannot say "NOT pgTAP" without amending the hash-locked parent. Path (a):
**pgTAP reinstated** — lane 1 installs `pgtap`/`pg_prove`, this suite uses pgTAP, no parent amendment
(the parent already assumed WS0 would introduce pgTAP). R1-F1 (accepted): there are TWO SQL harnesses;
the suite now **connects to lane 1's running stack over external `psql` via `pg_prove`** (NOT
`initdb`/`pg_ctl`), specs under `supabase/tests/mt/**`, runner `scripts/ci/sql-tests/run-mt-isolation-test.sh`
alongside the VTID-05149 tenant tests. Paths updated accordingly.
### 2026-10-18T18:40Z · kiro-hotmail-202610151618-b437 · spar round-2 → spec co-located, pinned install
R2-F3 (accepted): moved the pgTAP spec from `supabase/tests/mt/**` to
`scripts/ci/sql-tests/mt-isolation.test.sql`, beside the runner, matching the VTID-05149 layout so the
`SQL-MT-ISOLATION.yml` `paths:` stays on `scripts/ci/sql-tests/**` like every `SQL-*.yml`; front-matter
`paths` and tasks.md Allowed paths updated to the two co-located files. R2-F1 (accepted): the running
stack this suite depends on is the pinned `supabase/postgres` image (ships `pgtap`) + pinned `pg_prove`
— the one mechanism lane 1 and lane 6 share.
### 2026-10-19T18:00Z · kiro-hotmail-202610151618-b437 · spar round-1 (session 496d49e4) → PGHOST guard, glob wording
R1-F2 (accepted): `SQL-TENANT-FOUNDATION.yml` uses a per-file `paths:` list, so the glob is now modelled on
`SQL-HEALTH-STORE.yml`/`SQL-MEMORY-SENSITIVITY.yml`. R1-F3 (accepted): the runner copies the PGHOST
production guard from `run-tenant-foundation-test.sh:18-20`. `paths` unchanged.
### 2026-10-19T20:20Z · kiro-hotmail-202610151618-b437 · spar round-2 (session 496d49e4) → PASS marker
R2-F2 (accepted): the runner prints `PASS mt-isolation` last, only after `pg_prove` exits 0, so `ci-wiring`'s
report-gate step has a defined marker. `paths` unchanged.
