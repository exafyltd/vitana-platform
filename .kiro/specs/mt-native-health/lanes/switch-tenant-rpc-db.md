---
lane: switch-tenant-rpc-db
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: jtadic
paths:
  - supabase/migrations/20261101130000_mt_native_health_transport_flag.sql
  - supabase/migrations/*mt_native_health_transport_flag*rollback*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - test/db/mt-native-health-transport-flag.sql
updated: 2026-10-17T13:30Z
---
# Transport one-owner flag (DB); reuse existing switch RPC — mt-native-health (repo vitana-platform)

Plan: `.kiro/specs/mt-native-health/plan.md` (switch-tenant-rpc-db) and `tasks.md`. Design: `design.md`.

HELD until PLAN-SPAR allocates this lane's VTID and flips `next_actor` to `kiro`. DB lane — the change is a migration
file plus a pre-approved rollback and read-only pre/post checks; it is applied by Claude via RUN-MIGRATION after merge,
never by the executor (collaboration §7a). Depends on `mt-identity` (membership unification, `is_member`,
`tenant_id_for_policies()`) and A-M1 `tenants.is_default`/`is_platform` (`20261014000100`) — cross-spec deps, stated in
the body (lane `depends_on` lists lanes of THIS spec only, of which this lane has none).

§7a: no VTID allocation, no `_plan` claim, no merge/approve/deploy/workflow dispatch, no Supabase/AWS writes. Work only
inside the allowed paths. This lane adds its own `docs/validation/<vtid>/` (plan-sparring copy, scope.json,
post-apply + live-before SQL) — not listed in `paths`.

Scope is the per-device transport one-owner flag only. The active-tenant switch RPC already exists
(`switch_to_tenant_by_slug`, `20261010180200`, VTID-05043) and reserved slugs are already enforced (VTID-05150,
`20261014000400`/`20261014000500`) — do NOT re-create either, and do NOT re-seed reserved slugs from
`screens.json` (that is cross-repo and already produced by `scripts/tenants/gen-reserved-slugs.mjs` +
`TENANT-RESERVED-SLUGS-DRIFT.yml`). ONLY if a real switch-RPC gap is found at build time, extend
`switch_to_tenant_by_slug` in place (never a parallel RPC), keeping its `GRANT EXECUTE … TO authenticated` /
`REVOKE … FROM PUBLIC, anon` grants (`20261010180200:126-127`).

Branch `kiro/mt-native-health/switch-tenant-rpc-db`; PR title `VTID-xxxxx (mt-native-health/switch-tenant-rpc-db): …`;
commit trailers `Collab-Session: <your kiro session id>` and `Collab-Lane: mt-native-health/switch-tenant-rpc-db`.
Migration renumbered if a later one exists at build time; add the MIGRATION-QUEUE rows after row 8, order
switch-tenant-rpc-db → health-home-tenant-db.

## Log
### 2026-10-17T11:48Z · kiro-hotmail-202610151618-b437 · created → ready
Lane created (held). Reserved slugs from `vitana-v1/src/navigation/registry/screens.json` top-level routes;
`switch_active_tenant` SECURITY DEFINER, caller from `auth.uid()`; `user_device_tokens.transport` one-owner index.

### 2026-10-17T13:30Z · kiro-hotmail-202610151618-b437 · internal-review fix (ready)
Internal review HIGH W1/W2 + MEDIUM: this lane was re-creating already-applied reserved-slug work (VTID-05150) and a
near-duplicate switch RPC, and seeding reserved slugs from a cross-repo file. Re-scoped to the per-device transport
one-owner flag only; reserved slugs and the switch RPC are reused, not rebuilt; cross-repo screens.json seeding
removed. Migration renamed `..._transport_flag.sql`; `paths` and the test file updated to match.
