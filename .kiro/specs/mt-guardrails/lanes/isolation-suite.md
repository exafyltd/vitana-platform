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
  - scripts/ci/test-mt-isolation.sh
updated: 2026-10-18T10:00Z
---
# Isolation suite (raw-psql) — mt-guardrails/isolation-suite (repo vitana-platform)
Plan: `.kiro/specs/mt-guardrails/plan.md` (authoritative) and the `isolation-suite` section of
`tasks.md` (P1—P3, allowed paths, acceptance). Design and the rules you must follow: `design.md`.
`next_actor: owner` is HELD: it flips to `kiro` when PLAN-SPAR allocates this lane's VTID. Depends on
`local-test-stack` (the suite runs against its seeded local stack) and `generated-inventories` (for the
shared health-table-list constant).
Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of
`handoff.md`, no merge/approve/deploy/workflow dispatch, no live-system writes. The suite only ever
touches the local stack — it is read-only against production by construction (rules 31/48). It uses the
repo's established raw-psql + RAISE harness (`\set ON_ERROR_STOP 1`, `*.test.sql` + a
`scripts/ci/test-*.sh` runner that spins up a throwaway Postgres via `initdb`/`pg_ctl`), matching
`supabase/tests/vtid_05147_s_m_lockdown.test.sql` + `scripts/ci/test-vtid-05147-s-m-lockdown.sh` — NOT
pgTAP/`pg_prove`, which exists nowhere in the repo. For the health tables use the shared
health-table-list constant from `generated-inventories` (switching to mt-identity's `isHealthTable()`
when it ships), never a scattered local copy (CROSS-SPEC O1). Work only inside the allowed paths; add
this lane's own `docs/validation/<vtid>/`.
Branch `kiro/mt-guardrails/isolation-suite`; PR title `VTID-xxxxx
(mt-guardrails/isolation-suite): —`; commit trailers `Collab-Session: <your kiro session id>` and
`Collab-Lane: mt-guardrails/isolation-suite`. When the PR is open: set `state: in-review`,
`next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.
## Log
### 2026-10-16T21:44Z · kiro-hotmail-202610151618-b437 · created → ready
Created from the WS0 plan. Asserts b_member reads 0 T_A rows on the 18 tenant tables + the health tables
and that cross-tenant writes fail. Held at `next_actor: owner` until the VTID is allocated.
### 2026-10-18T10:00Z · kiro-hotmail-202610151618-b437 · spar round-1 → raw-psql
Renamed from `pgtap-isolation-suite` to `isolation-suite` (R1-F1, accepted): the suite uses the repo's
existing raw-psql + RAISE harness, not pgTAP/`pg_prove` (none exists in the repo). Paths changed from
`scripts/mt/pgtap/**` to `scripts/ci/test-mt-isolation.sh`; added `depends_on: generated-inventories`
for the shared health-table-list constant.
