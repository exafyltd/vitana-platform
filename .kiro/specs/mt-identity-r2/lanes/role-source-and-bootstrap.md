---
lane: role-source-and-bootstrap
state: ready
next_actor: kiro
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
depends_on:
  - membership-unification
paths:
  - supabase/migrations/20261102033000_vtid_*_single_role_source.sql
  - supabase/migrations/20261102033100_vtid_*_fix_bootstrap_admin_user.sql
  - supabase/migrations/20261102033000_vtid_*_role_source_rollback.sql
  - supabase/tests/mt_identity_roles_*.sql
updated: 2026-11-01T15:00Z
repos: [exafyltd/vitana-platform]
---
# role-source-and-bootstrap — one role source + fix bootstrap_admin_user (DB)

Plan: `.kiro/specs/mt-identity-r2/plan.md` (authoritative) and the `role-source-and-bootstrap` group of `tasks.md`
(R1–R3, allowed paths, acceptance). Design: `design.md`. The VTID comes from PLAN-SPAR on convergence.

Scope:
- `user_tenants.active_role` becomes the one role source of truth, and the others derive from it.
- Redefine `bootstrap_admin_user`. Its last definition is vitana-v1 `20250915132930_…:166`, which keys on
  `tenants.name IN ('Maxina','Alkalma','Earthlings')` (`:236`) and `name = 'Maxina'` (`:246`, `:254`) and writes
  `memberships` (`:233`). The new body keys on `tenants.is_default`, writes `user_tenants` through the dual-write
  path and keeps the signature.
- Expand/contract, snapshot first.
- Depends on `membership-unification`.

Rules (§7a): migration files in this PR, and no live write. After merge, Kiro applies them only on the owner's
approval of the files and the target database (§7d). Branch `kiro/mt-identity-r2/role-source-and-bootstrap`. PR
title `VTID-xxxxx (mt-identity-r2/role-source-and-bootstrap): …`. Trailers `Collab-Session` +
`Collab-Lane: mt-identity-r2/role-source-and-bootstrap`.

## Log
### 2026-11-01T15:00Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-identity/role-source-and-bootstrap`. Corrected the `bootstrap_admin_user` source to its last
definition (vitana-v1 `20250915132930`).
