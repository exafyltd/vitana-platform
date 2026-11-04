# VTID-05465 — MIGRATION-QUEUE rows (H4)

Rows for `docs/multitenancy/MIGRATION-QUEUE.md`, after the existing rows (#10 is
`20261101110100_mt_launch_tenant_content_pipeline.sql`). That file is not in this lane's `paths`, so the rows are
recorded here; whoever owns the queue file adds them in this position. Lane range: mt-identity-r2
`20261102030000`–`20261102035959`.

| # | Migration | Lane / VTID | Depends on | Rollback | Apply window | Status |
|---|-----------|-------------|------------|----------|--------------|--------|
| 11 | `20261102030000_vtid_05465_tenant_id_for_policies_is_member.sql` | mt-identity-r2 helpers-and-policy-rewrite / VTID-05465 (H1) | live `user_tenants` with its unique `(tenant_id, user_id)` index (the migration refuses without it) | last section of `20261102030100_vtid_05465_bare_policy_rewrite_rollback.sql` (drops both helpers once nothing references them) | off-peak; `docs/validation/VTID-05465/pre-check.sql` first | pending (owner approval of file + target, §7d) |
| 12 | `20261102030100_vtid_05465_bare_policy_rewrite.sql` | mt-identity-r2 helpers-and-policy-rewrite / VTID-05465 (H2) | #11 (the migration refuses without the helpers); every rewrite-set policy live as on main (refuses on drift); the live `current_tenant_id()` body is the 20260218 body (refuses on the 20251229 body, AC-12) | `20261102030100_vtid_05465_bare_policy_rewrite_rollback.sql` (pre-approved; same audience, puts current_tenant_id() back, so the lint reads 32 again) | right after #11; `docs/validation/VTID-05465/post-check.sql` after (bare count 0) | pending (owner approval of file + target, §7d); parked for an owner decision if `pre-check.sql` section 5 shows the old `current_tenant_id()` body |
