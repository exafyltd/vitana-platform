---
lane: isolation-suite
state: ready
next_actor: owner
executor: kiro
seat: hotmail
reviewer_seat: exafy
depends_on: [local-test-stack, generated-inventories]
paths:
  - supabase/tests/mt/**
  - scripts/ci/sql-tests/run-mt-isolation-test.sh
updated: 2026-10-18T16:20Z
---
# Isolation suite (pgTAP) — mt-guardrails/isolation-suite (repo vitana-platform)
Plan: `.kiro/specs/mt-guardrails/plan.md` (authoritative) and the `isolation-suite` section of
`tasks.md` (P1—P3, allowed paths, acceptance). Design and the rules you must follow: `design.md`.
`next_actor: owner` is HELD: it flips to `kiro` when PLAN-SPAR allocates this lane's VTID. Depends on
`local-test-stack` (the suite runs against its seeded, running local stack, which also installs the
`pgtap` extension + `pg_prove`) and `generated-inventories` (for the shared health-table-list constant).
Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of
`handoff.md`, no merge/approve/deploy/workflow dispatch, no live-system writes. The suite only ever
touches the local stack — it is read-only against production by construction (rules 31/48). It uses
**pgTAP**, which the hash-stamped parent program plan mandates for exactly these assertions
(`docs/MULTI-TENANT-PLAN.md` §4.2 at `:51` and §4.9 at `:61`; parent plan-body hash
`869182cc6aef344b107c6a8915fe2271bbd1bc982febb198f09027e7eb451326` at `:1`). This spec is the first
introduction of pgTAP into the repo — path (a) from sparring round 1; the parent already assumed WS0
would introduce it, so no parent amendment is made (R1-F2). The runner invokes `pg_prove` over
**external `psql`** against lane 1's running stack (NOT `initdb`/`pg_ctl`), extending the
`scripts/ci/sql-tests/` harness location where the closest analogue — the VTID-05149 tenant-foundation
tests (`scripts/ci/sql-tests/vtid-05149-tenant-foundation.test.sql` +
`scripts/ci/sql-tests/run-tenant-foundation-test.sh`) — already lives (R1-F1). For the health tables
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
