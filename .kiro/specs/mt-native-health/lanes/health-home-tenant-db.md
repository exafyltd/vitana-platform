---
lane: health-home-tenant-db
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: jtadic
paths:
  - supabase/migrations/20261101131000_mt_native_health_home_tenant.sql
  - supabase/migrations/*mt_native_health_home_tenant*rollback*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - test/db/mt-native-health-home-tenant.sql
updated: 2026-10-17T11:48Z
---
# Frozen health home tenant — app_users.health_home_tenant_id (DB) — mt-native-health (repo vitana-platform)

Plan: `.kiro/specs/mt-native-health/plan.md` (health-home-tenant-db) and `tasks.md`. Design: `design.md`.

HELD until PLAN-SPAR allocates this lane's VTID. DB lane — migration + pre-approved rollback + read-only pre/post
checks, applied by Claude via RUN-MIGRATION after merge, never by the executor (§7a). Depends on `mt-identity`
(membership unification — the backfill reads each user's current primary `user_tenants` row) and A-M1
`tenants.is_default`/`is_platform` (`20261014000100`) for the FK/default — cross-spec deps, stated here (lane
`depends_on` lists lanes of THIS spec only; this lane shares the migration queue position after `switch-tenant-rpc-db`
but has no in-spec lane dependency).

Health table membership is referenced via `mt-identity`'s canonical `isHealthTable()` predicate (CROSS-SPEC O1) — this
lane never defines its own list. `health_home_tenant_id` is set-once and NOT changed when `is_primary` changes.

§7a: no VTID allocation, no `_plan` claim, no merge/approve/deploy, no Supabase/AWS writes. Allowed paths only. Own
`docs/validation/<vtid>/` (plan-sparring copy, scope.json, live-before + post-apply SQL) — not in `paths`. Backfill
batched/off-peak per §4.7.

PR title `VTID-xxxxx (mt-native-health/health-home-tenant-db): …`; trailers `Collab-Session: <id>`,
`Collab-Lane: mt-native-health/health-home-tenant-db`.

## Log
### 2026-10-17T11:48Z · kiro-hotmail-202610151618-b437 · created → ready
Lane created (held). `health_home_tenant_id uuid REFERENCES tenants`, backfill to current primary membership,
set-once BEFORE-INSERT trigger at first health write; health tables stay user-owned.
