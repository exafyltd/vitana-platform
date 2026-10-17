---
lane: tenant-lifecycle-db
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: jtadic
paths:
  - supabase/migrations/20261101070300_vtid_*_mt_tenant_deactivate.sql
  - supabase/migrations/20261101070350_vtid_*_mt_tenant_archive_switch.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
updated: 2026-10-15T16:18Z
---
# Tenant lifecycle DB — deactivate/archive + closing switch RPC (repo vitana-platform)

Plan: `.kiro/specs/mt-tenant-admin/plan.md` (authoritative) and the `tenant-lifecycle-db` section of `tasks.md`.
Design and the rules you must follow: `design.md`.

**HELD until PLAN-SPAR allocates the VTID.** `next_actor: owner`, no `vtid`: PLAN-SPAR writes the VTID into this still-
`ready` lane and flips `next_actor` to kiro on a converged plan. Do not self-allocate.

Owns deactivate/archive end to end at the DB layer (CROSS-SPEC O2): `deactivate_tenant(slug)` / `archive_tenant(slug)`
RPCs and the **closing switch RPC** change so a deactivated tenant's members resolve to the default tenant (never a
hard lockout — the gateway reads `is_active` at `services/gateway/src/routes/admin-tenants.ts:253` and already excludes
inactive tenants from switch targets; this lane makes the member-resolution side safe). Migrations `070300`/`070350`,
sorting after mt-community-isolation C3 (`070160`) and after P2/P3. Each ships a rollback under
`docs/validation/<vtid>/`, read-only pre/post checks, a MIGRATION-QUEUE row in the same PR; expand/contract only,
`lock_timeout` + retries, snapshot before any data move. The lane adds its own `docs/validation/<vtid>/` in the PR.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, **no Supabase or AWS writes** — a DB change is a migration file applied later
by Claude via RUN-MIGRATION. Work only inside the allowed paths. Branch `kiro/mt-tenant-admin/tenant-lifecycle-db`;
PR title `VTID-xxxxx (mt-tenant-admin/tenant-lifecycle-db): …`; commit trailers `Collab-Session: <your kiro session
id>` and `Collab-Lane: mt-tenant-admin/tenant-lifecycle-db`. When the PR is open: set `state: in-review`,
`next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T16:18Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the mt-* program planner (session kiro-hotmail-202610151618-b437, holding `mt-tenant-admin/_plan`). DB lane,
separate from the gateway code lane per §4.7. Reviewer seat `jtadic` (≠ `hotmail`). Held for PLAN-SPAR VTID allocation.
