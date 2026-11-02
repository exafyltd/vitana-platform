---
lane: platform-only-accounts-db
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102070160_*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - supabase/tests/mt_platform_only_accounts_*.sql
updated: 2026-11-01T15:20Z
repos: [exafyltd/vitana-platform]
---
# platform_only_accounts view — M2, cross-spec O5 (DB) — mt-community-isolation-r2/platform-only-accounts-db (repo vitana-platform)

The VTID comes from PLAN-SPAR on convergence, never by hand. Plan: `../plan.md`; tasks/paths/acceptance: `../tasks.md`
(`<!-- lane: platform-only-accounts-db -->`); design: `../design.md`.

M2 (cross-spec O5): creates the `platform_only_accounts` view — members of the platform tenant
(`tenants.is_platform = true`, from VTID-05149) with no community membership — and adds it to the
rule-45 exclusion lint alongside `service_bot_accounts` and `notification_test_actors`, so a
platform-only account never surfaces on any community-member surface. **The migration version is
pinned to `20261102070160`** (cross-spec C3 ordering, reserved inside spec 07's gap — do not
renumber). MIGRATION-QUEUE position: after the two `20261102060*` community lanes, as the C3 row;
mt-discover references this view (O5) — no stale Risks line there.

Rules (§7a): no live writes; migration applied by Kiro via RUN-MIGRATION after merge, only on the owner's approval of the files and the target database (§7d); rollback +
read-only pre/post checks under `docs/validation/<vtid>/`. A view is read-only — no expand/contract
needed, but add the MIGRATION-QUEUE row and the drift-baseline entry (removed after apply) in this PR.
Depends on WS1's `is_member()`/`tenant_id_for_policies()` emitting the platform tenant for
platform-only accounts (external — stated here, not in `depends_on`).

Branch `kiro/mt-community-isolation-r2/platform-only-accounts-db`;
PR title `VTID-xxxxx (mt-community-isolation-r2/platform-only-accounts-db): …`; trailers
`Collab-Session`/`Collab-Lane: mt-community-isolation-r2/platform-only-accounts-db`. On PR open: `state:
in-review`, `next_actor: kiro`, `pr:`, log entry, release the claim.

## Log
### 2026-11-01T15:20Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-community-isolation/platform-only-accounts-db`. The pinned C3 version is day-shifted to `20261102070160`.
