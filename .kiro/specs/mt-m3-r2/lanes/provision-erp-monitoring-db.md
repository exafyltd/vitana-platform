---
lane: provision-erp-monitoring-db
state: ready
next_actor: kiro
depends_on: [tenant-domains-db]
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102141000_vtid_*_mt_provision_erp_request.sql
  - supabase/migrations/20261102141000_vtid_*_mt_provision_erp_request_rollback.sql
  - supabase/migrations/20261102141100_vtid_*_mt_isolation_health_by_tenant.sql
  - supabase/migrations/20261102141100_vtid_*_mt_isolation_health_by_tenant_rollback.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
updated: 2026-11-01T15:43Z
repos: [exafyltd/vitana-platform]
---
# ERP bootstrap request + per-tenant isolation health — mt-m3 (repo vitana-platform)

Plan: `.kiro/specs/mt-m3-r2/plan.md`; tasks E1–E4 in `tasks.md`; design in `design.md`. Extends `provision_tenant()` to
idempotently record the §4.6 ERP bootstrap request (`tenant_settings.feature_flags.erp.bootstrap_requested`) — because
the `tenant_settings` INSERT is `ON CONFLICT (tenant_id) DO NOTHING`, the flag is set by a guarded `UPDATE ...
jsonb_set(...)` AFTER the INSERT so a re-run on an already-provisioned tenant still records it; `erp` becomes a governed
key in `tenant_settings_merge_feature_flags()` (`- 'jev' - 'erp'` for non-exafy-admin callers) — and adds
`ci_tenant_isolation_health_by_tenant()` (same counts per tenant, summing to the unchanged `ci_tenant_isolation_health()`).
Expand/contract; rollbacks + read-only pre/post checks; MIGRATION-QUEUE rows after `tenant-domains-db`. depends_on
`tenant-domains-db` only for queue ordering (shares `MIGRATION-QUEUE.md` / `migration-drift-baseline.json`); the two DB
lanes are serialised so their queue edits do not conflict. The lane adds its own `docs/validation/<vtid>/`.

Rules (collaboration §7a): no VTID allocation, no `_plan` claim, no `handoff.md` edit, no merge/approve/deploy/dispatch,
no Supabase/AWS writes (DB applies are Kiro via RUN-MIGRATION, only on the owner's approval of the files and the target database, §7d). Work only inside the allowed paths. Branch
`kiro/mt-m3-r2/provision-erp-monitoring-db`; PR title `VTID-xxxxx (mt-m3-r2/provision-erp-monitoring-db): …`; trailers
`Collab-Session` / `Collab-Lane: mt-m3-r2/provision-erp-monitoring-db`. When the PR is open: set `state: in-review`,
`next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.


## Log
### 2026-11-01T15:43Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-m3/provision-erp-monitoring-db`. Versions day-shifted to `20261102140*`. Executor and reviewer follow today's §3a/§7 rules.
