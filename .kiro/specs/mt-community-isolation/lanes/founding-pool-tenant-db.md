---
lane: founding-pool-tenant-db
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: exafy
paths:
  - supabase/migrations/20261101061*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - supabase/tests/mt_founding_pool_*.sql
updated: 2026-10-17T16:10Z
---
# Founding pool per tenant (DB) — mt-community-isolation/founding-pool-tenant-db (repo vitana-platform)
HELD: `next_actor: owner`, no `vtid` until PLAN-SPAR converges and allocates it (then flips to
`kiro`). Plan: `../plan.md`; tasks/paths/acceptance: `../tasks.md`
(`<!-- lane: founding-pool-tenant-db -->`); design: `../design.md`.
Makes the Founding pool per tenant (program plan D10). **`founding_members.tenant_id` and
`claim_founding_seat(p_user_id, p_tenant_id)` already exist and are populated** (VTID-04859,
`supabase/migrations/20261003100000_vtid_04859_founding_1000.sql:66,107-115`), so this lane does
**no column add and no `tenant_id` backfill** — it verifies the column is already populated, then
makes the cap and seat numbering per tenant: per-tenant seat allocation `max(seat_number)+1 WHERE
tenant_id = p_tenant_id` (replacing the table-wide `max(seat_number)+1` at `:131`),
`UNIQUE (tenant_id, seat_number)` + a per-tenant cap check (replacing the global
`UNIQUE`/`CHECK (seat_number BETWEEN 1 AND 1000)` at `:46`), and `v_max_seats` (`:76`) as a per-tenant
cap. **Advisory lock strategy (decided):** the current single platform-wide key
`pg_advisory_xact_lock(hashtext('vtid_04859_founding_1000'))` (`:117`) becomes a per-tenant key
`hashtext('vtid_04859_founding_1000_' || p_tenant_id::text)` — keeping the global key would serialise
every tenant's signups (scaling regression); dropping it would let concurrent same-tenant calls race
on `max(seat_number) WHERE tenant_id = X` and violate `UNIQUE (tenant_id, seat_number)`. "Per-tenant
sequence" here means this per-tenant max+lock, NOT a Postgres `SEQUENCE` object. `bak_founding_members`
snapshot first; the new per-tenant uniqueness is validated against existing rows before the global
constraints are dropped; pre-approved rollback migration; read-only pre/post checks; pgTAP proves
concurrent same-tenant claims do not collide and two tenants may both hold seat 1. Separate DB lane
(independent table + RPC, own queue row). Version in `20261101061000–061959`.
Rules (§7a) as in the sibling DB lane: no live writes; the migration file is applied by Claude via
RUN-MIGRATION after merge; add the MIGRATION-QUEUE row in this PR after the community-tables rows.
Gateway `countFoundingSeats`/`/founding-status` tenant scoping is read-only reporting and ships in the
code lane; this lane owns only the DB schema + RPC. Depends on WS1 membership canonicalisation
(external — stated here, not in `depends_on`).
Branch `kiro/mt-community-isolation/founding-pool-tenant-db`;
PR title `VTID-xxxxx (mt-community-isolation/founding-pool-tenant-db): …`; trailers
`Collab-Session`/`Collab-Lane: mt-community-isolation/founding-pool-tenant-db`. On PR open: `state:
in-review`, `next_actor: kiro`, `pr:`, log entry, release the claim.
## Log
### 2026-10-15T16:30Z · kiro-hotmail-202610151618-b437 · created → ready
Lane drafted. HELD until PLAN-SPAR allocates the VTID.
### 2026-10-17T16:10Z · kiro-hotmail-202610151618-b437 · premise line-refs re-verified
Re-verified `20261003100000_vtid_04859_founding_1000.sql` against origin/main today: global
`UNIQUE CHECK (seat_number BETWEEN 1 AND 1000)` at `:46`, `v_max_seats constant := 1000` at `:76`,
`claim_founding_seat` definition at `:66`, table-wide `max(seat_number)+1` at `:131`. Corrected the
drifted `:57,:127` citations to the verified lines. No scope change.
