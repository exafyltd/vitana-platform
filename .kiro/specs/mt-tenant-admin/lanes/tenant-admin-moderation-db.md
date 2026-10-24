---
lane: tenant-admin-moderation-db
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: jtadic
paths:
  - supabase/migrations/20261101070100_vtid_*_mt_tenant_admin_p2_moderation.sql
  - supabase/migrations/20261101070150_vtid_*_mt_tenant_admin_p3_moderation.sql
  - supabase/migrations/20261101070600_vtid_*_mt_moderator_tenant_scope.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
updated: 2026-10-15T16:18Z
---
# Tenant-admin moderation DB — P2/P3 + moderator tenant-scope (repo vitana-platform)

Plan: `.kiro/specs/mt-tenant-admin/plan.md` (authoritative) and the `tenant-admin-moderation-db` section of
`tasks.md`. Design and the rules you must follow: `design.md`.

**HELD until PLAN-SPAR allocates the VTID.** `next_actor: owner` with no `vtid` is intentional: on a converged plan
PLAN-SPAR writes the VTID into this still-`ready` lane and flips `next_actor` to kiro itself. Do not self-allocate.

Owns moderation (CROSS-SPEC O4): this lane + the gateway lane carry the moderation RPCs/triggers/predicate; there is
no `moderation-tenant-db` lane. Migrations P2 `070100`, P3 `070150`, moderator-tenant-scope `070600`. **mt-community-
isolation C3 is reserved at `070160`** — these files sort around it. MIGRATION-QUEUE order: P2 → P3 → C3 → (lifecycle)
→ moderator-tenant-scope. Each migration ships its rollback under `docs/validation/<vtid>/`, read-only pre/post checks,
and a MIGRATION-QUEUE row in the same PR; a not-yet-live table goes into `migration-drift-baseline.json` and is removed
after apply. Expand/contract only; `lock_timeout` + retries; snapshot before any data move. The lane adds its own
`docs/validation/<vtid>/` (not in `paths`; see collaboration §2 — the executor creates it in the PR).

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, **no Supabase or AWS writes** — a DB change is a migration file in this PR,
applied later by Claude via RUN-MIGRATION. Work only inside the allowed paths. Branch
`kiro/mt-tenant-admin/tenant-admin-moderation-db`; PR title `VTID-xxxxx (mt-tenant-admin/tenant-admin-moderation-db):
…`; commit trailers `Collab-Session: <your kiro session id>` and `Collab-Lane: mt-tenant-admin/tenant-admin-
moderation-db`. When the PR is open: set `state: in-review`, `next_actor: kiro`, `pr: <url>`, append a log entry,
release the claim.

## Log
### 2026-10-15T16:18Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the mt-* program planner (session kiro-hotmail-202610151618-b437, holding `mt-tenant-admin/_plan`). DB lane,
separate from the gateway code lane per §4.7. Reviewer seat `jtadic` (≠ `hotmail`). Held for PLAN-SPAR VTID allocation.
