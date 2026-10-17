---
lane: role-source-and-bootstrap
state: ready
next_actor: owner
depends_on:
  - membership-unification
executor: kiro
seat: hotmail
reviewer_seat: exafy
paths:
  - supabase/migrations/20261101033000_vtid_xxxxx_single_role_source.sql
  - supabase/migrations/20261101033100_vtid_xxxxx_fix_bootstrap_admin_user.sql
  - supabase/migrations/20261101033000_vtid_xxxxx_role_source_rollback.sql
updated: 2026-11-01T00:00Z
---
# role-source-and-bootstrap — one role source of truth + fix bootstrap_admin_user (DB)

Plan: `.kiro/specs/mt-identity/plan.md`, `tasks.md` group `<!-- lane: role-source-and-bootstrap -->`. Design: `design.md`.

**Held:** `next_actor: owner` until PLAN-SPAR allocates the VTID. Depends on `membership-unification` (the single role
source reads canonical `user_tenants.active_role`).

Scope: pick ONE role source of truth across `role_preferences` / `active_role` / `user_permitted_roles` (program plan
WS1) and make the others derive from it; fix `bootstrap_admin_user` — today it pins `tenants.name = 'Maxina'`
(vitana-v1 migration `20250831…`, wrong key column) and inserts into `memberships`. Rewrite it to use `tenants.is_default`
and write `user_tenants` (now canonical), through the dual-write path. Expand/contract; snapshot before any role data
move.

§7a: migration files in the PR; Claude applies via RUN-MIGRATION. Add `docs/validation/<vtid>/` + MIGRATION-QUEUE rows.
Branch `kiro/mt-identity/role-source-and-bootstrap`; PR title `VTID-xxxxx (mt-identity/role-source-and-bootstrap): …`;
trailers `Collab-Session` + `Collab-Lane: mt-identity/role-source-and-bootstrap`.

## Log
### 2026-11-01T00:00Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the mt-identity planner. Verified read-only: `bootstrap_admin_user` pins `name = 'Maxina'`. Held pending
PLAN-SPAR VTID allocation.
