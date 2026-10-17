---
lane: membership-unification
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: exafy
paths:
  - supabase/migrations/20261101031000_vtid_xxxxx_user_tenants_canonical.sql
  - supabase/migrations/20261101031100_vtid_xxxxx_memberships_view_dualwrite.sql
  - supabase/migrations/20261101031200_vtid_xxxxx_membership_drift_report.sql
  - supabase/migrations/20261101031000_vtid_xxxxx_membership_unification_rollback.sql
updated: 2026-11-01T00:00Z
---
# membership-unification — user_tenants canonical, memberships → view, dual-write + drift report (DB)

Plan: `.kiro/specs/mt-identity/plan.md`, `tasks.md` group `<!-- lane: membership-unification -->`. Design: `design.md`.

**Held:** `next_actor: owner` until PLAN-SPAR allocates the VTID.

Scope: make `user_tenants` (with `is_primary`/`active_role`) the single canonical membership store; backfill the
drifted rows (program plan N1: maxina 11, alkalma 4 memberships-only; verify counts read-only at implementation);
replace `memberships` with a view over `user_tenants` while a dual-write trigger keeps legacy writers working; add a
nightly drift report (reads 0 when converged). Expand/contract only (§4.7); snapshot before any data move; the
`memberships` → view cutover is a contract step that must not break the four `user_tenants` AFTER INSERT triggers (N1
side-effect guard). This lane does not touch `current_tenant_id()` or the hook.

§7a as in the sibling DB lanes: migration files in the PR, Claude applies via RUN-MIGRATION, add
`docs/validation/<vtid>/` + MIGRATION-QUEUE rows here.
Branch `kiro/mt-identity/membership-unification`; PR title `VTID-xxxxx (mt-identity/membership-unification): …`;
trailers `Collab-Session` + `Collab-Lane: mt-identity/membership-unification`.

## Log
### 2026-11-01T00:00Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the mt-identity planner. Held pending PLAN-SPAR VTID allocation.
