---
lane: membership-unification
state: ready
next_actor: kiro
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
depends_on: []
paths:
  - supabase/migrations/20261102031000_vtid_*_user_tenants_canonical.sql
  - supabase/migrations/20261102031100_vtid_*_memberships_view_dualwrite.sql
  - supabase/migrations/20261102031200_vtid_*_membership_drift_report.sql
  - supabase/migrations/20261102031000_vtid_*_membership_unification_rollback.sql
  - supabase/tests/mt_identity_membership_*.sql
updated: 2026-11-01T15:00Z
repos: [exafyltd/vitana-platform]
---
# membership-unification — user_tenants canonical, memberships → view, dual-write + drift report (DB)

Plan: `.kiro/specs/mt-identity-r2/plan.md` (authoritative) and the `membership-unification` group of `tasks.md`
(M1–M3, allowed paths, acceptance). Design: `design.md`. The VTID comes from PLAN-SPAR on convergence.

Scope:
- `user_tenants` becomes canonical (`20251231000000_vtid_01101_phase_a_bootstrap.sql:90`, `UNIQUE (tenant_id,
  user_id)` `:98`).
- Backfill the drifted `memberships`-only rows with `membership_side_effects_suppressed()` true, so the four AFTER
  INSERT triggers (`20261010180000_vtid_05043_…:46-70`) do not fire.
- `memberships` (a table, vitana-v1 `20250831074859_…:32`) becomes a view with a dual-write trigger
  (`ON CONFLICT (tenant_id, user_id) DO NOTHING`).
- A nightly drift report reads 0 when the two are converged.
- The bot user `…0001` and every `service_bot_accounts` user are excluded from the backfill and from the counts.
- Expand/contract, snapshot first.

Rules (§7a): migration files in this PR, and no live write. After merge, Kiro applies them only on the owner's
approval of the files and the target database (§7d). Branch `kiro/mt-identity-r2/membership-unification`. PR title
`VTID-xxxxx (mt-identity-r2/membership-unification): …`. Trailers `Collab-Session` +
`Collab-Lane: mt-identity-r2/membership-unification`.

## Log
### 2026-11-01T15:00Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-identity/membership-unification`. The trigger names and suppression guard were re-verified on
`62990ce285`.
