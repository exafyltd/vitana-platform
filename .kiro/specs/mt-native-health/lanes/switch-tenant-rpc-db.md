---
lane: switch-tenant-rpc-db
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: jtadic
paths:
  - supabase/migrations/20261101130000_mt_native_health_switch_tenant_rpc.sql
  - supabase/migrations/*mt_native_health_switch_tenant_rpc*rollback*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - test/db/mt-native-health-switch-tenant.sql
updated: 2026-10-17T11:48Z
---
# switch_active_tenant RPC + reserved slugs + transport flag (DB) — mt-native-health (repo vitana-platform)

Plan: `.kiro/specs/mt-native-health/plan.md` (switch-tenant-rpc-db) and `tasks.md`. Design: `design.md`.

HELD until PLAN-SPAR allocates this lane's VTID and flips `next_actor` to `kiro`. DB lane — the change is a migration
file plus a pre-approved rollback and read-only pre/post checks; it is applied by Claude via RUN-MIGRATION after merge,
never by the executor (collaboration §7a). Depends on `mt-identity` (membership unification, `is_member`,
`tenant_id_for_policies()`) and A-M1 `tenants.is_default`/`is_platform` (`20261014000100`) — cross-spec deps, stated in
the body (lane `depends_on` lists lanes of THIS spec only, of which this lane has none).

§7a: no VTID allocation, no `_plan` claim, no merge/approve/deploy/workflow dispatch, no Supabase/AWS writes. Work only
inside the allowed paths. This lane adds its own `docs/validation/<vtid>/` (plan-sparring copy, scope.json,
post-apply + live-before SQL) — not listed in `paths`.

Branch `kiro/mt-native-health/switch-tenant-rpc-db`; PR title `VTID-xxxxx (mt-native-health/switch-tenant-rpc-db): …`;
commit trailers `Collab-Session: <your kiro session id>` and `Collab-Lane: mt-native-health/switch-tenant-rpc-db`.
Migration renumbered if a later one exists at build time; add the MIGRATION-QUEUE rows after row 8, order
switch-tenant-rpc-db → health-home-tenant-db.

## Log
### 2026-10-17T11:48Z · kiro-hotmail-202610151618-b437 · created → ready
Lane created (held). Reserved slugs from `vitana-v1/src/navigation/registry/screens.json` top-level routes;
`switch_active_tenant` SECURITY DEFINER, caller from `auth.uid()`; `user_device_tokens.transport` one-owner index.
