---
lane: supplier-relationships-db
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102120000_*_supplier_tenant_relationships.sql
  - supabase/migrations/20261102120100_*_products_distribution.sql
  - supabase/migrations/20261102120200_*_partner_tenant_backfill.sql
  - supabase/migrations/20261102120300_*_products_merchants_tenant_rls.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
  - services/gateway/test/vtid-*-supplier-tenant-relationships.test.ts
updated: 2026-11-01T15:57Z
repos: [exafyltd/vitana-platform]
---
# supplier-relationships-db — tenant↔supplier + offering distribution (VTID allocated by PLAN-SPAR, repo vitana-platform)

Plan: `.kiro/specs/mt-discover-r2/plan.md` (authoritative) and the `supplier-relationships-db` group in `tasks.md`
(tasks D1–D6, allowed paths, acceptance). Design + successor rules: `design.md`.

The VTID comes from PLAN-SPAR on convergence, never by hand.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes — the migration is a FILE in this PR; Kiro applies on the owner's approval (§7d)
it via RUN-MIGRATION after merge. Work only inside the allowed paths. This lane adds its own
`docs/validation/<vtid>/` (migrations, rollback, `live-before.sql`, `post-apply-checks.sql`). Branch
`kiro/mt-discover-r2/supplier-relationships-db`; PR title `VTID-xxxxx (mt-discover-r2/supplier-relationships-db): …`;
commit trailers `Collab-Session: <your kiro session id>` and `Collab-Lane: mt-discover-r2/supplier-relationships-db`.
When the PR is open: set `state: in-review`, `next_actor: kiro` (reviewer seat `jtadic`), `pr: <url>`, append a log
entry, release the claim.

Migrations in range 20261102120000–125959; renumber if a later migration exists at implementation; add MIGRATION-QUEUE
rows at the WS11 position (depends on A-M1 `tenants.is_default`/`is_platform` and mt-identity-r2 policy classification);
not-yet-live tables go in `scripts/ci/migration-drift-baseline.json`, removed in the PR after apply.

## Log
### 2026-11-01T15:57Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-discover/supplier-relationships-db`. Versions day-shifted to `20261102120*`. Reviewer agent.
