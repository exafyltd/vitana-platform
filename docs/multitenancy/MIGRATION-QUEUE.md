# Multi-tenant migration queue

The single ordered list of every multi-tenant migration (program plan §8),
created by VTID-05149 (lane A). **Every concurrent multi-tenant lane adds its
migrations here in the same PR that adds the files**, in the position it must be
applied. Apply strictly top to bottom, one `RUN-MIGRATION.yml` dispatch per file
(`migration_file=…`), running the lane's post-check after each. A row is marked
applied only after its post-check passed. (A CI check that enforces this file is
the WS0 lint slice; until then it is a review rule.)

Lane number ranges: S-M `20261013233000`; A `20261014000100`–`000300`;
B `20261014000400`–`000500`; C `20261014000600`–`000700`;
mt-launch (WS8) `20261101110000`–`20261101115959`.

| # | Migration | Lane / VTID | Depends on | Rollback | Apply window | Status |
|---|-----------|-------------|------------|----------|--------------|--------|
| 1 | `20261013233000_vtid_05147_s_m_membership_role_lockdown.sql` | S-M / VTID-05147 | — | `docs/validation/VTID-05147/rollback-s-m.sql` (re-opens the hole, owner approval) | first (security); pre-apply STOP checks, re-run after apply | applied 2026-10-13 (RUN-MIGRATION 38430363394), post-checks clean |
| 2 | `20261014000100_vtid_05149_tenants_default_platform_flags.sql` | A / VTID-05149 (M1) | — | `docs/validation/VTID-05149/rollback-m1.sql` (only after R2 and the gateway revert) | off-peak, after `docs/validation/VTID-05149/live-before.sql` matches; before the gateway deploy | applied 2026-10-13 (RUN-MIGRATION 38444968243), post-check clean |
| 3 | `20261014000200_vtid_05149_signup_default_tenant.sql` | A / VTID-05149 (M2) | #2; live md5s of `handle_new_user()` / `provision_platform_user()` (guarded) | `docs/validation/VTID-05149/rollback-m2.sql` | same window, right after #2 | applied 2026-10-13 (RUN-MIGRATION 38446340122), post-check clean |
| 4 | `20261014000300_vtid_05149_ci_tenant_isolation_health.sql` | A / VTID-05149 (M3) | — (independent) | `docs/validation/VTID-05149/rollback-m3.sql` | same window, after #3 | applied 2026-10-13 (RUN-MIGRATION 38450645927), post-check clean |
| 5 | `20261014000400_vtid_05150_tenant_brand_pack.sql` | B / VTID-05150 (M1) | — (independent; expand only) | `docs/validation/VTID-05150/rollback.sql` (+ `rollback-complete.sql` when a tenant was provisioned) | after lane A; `docs/validation/VTID-05150/live-before.sql` first, `post-apply-checks.sql` (M1 section) after | applied 2026-10-13 (RUN-MIGRATION 38451964236), post-check clean |
| 6 | `20261014000500_vtid_05150_provision_tenant.sql` | B / VTID-05150 (M2) | B-M1 **and A-M1** (`20261014000100`, `tenants.is_default`/`is_platform`; the migration refuses without them) | `docs/validation/VTID-05150/rollback.sql` (`DROP FUNCTION provision_tenant`) | only after A-M1's post-check passed; right after B-M1; `post-apply-checks.sql` (M2 section) after | applied 2026-10-13 (RUN-MIGRATION 38455354298), post-check clean (service_role-only EXECUTE, no tenant created) |
| 7 | `20261014000600_vtid_05151_public_tenant_registry.sql` | C / VTID-05151 (M1) | — (reads A/B columns through `to_jsonb` when present) | `docs/validation/VTID-05151/rollback-registry.sql` | after lane B; before the v1 registry PR merges | applied 2026-10-13 (RUN-MIGRATION 38457942567), post-check clean (anon reads 2 legacy rows, whitelisted keys only) |
| 8 | `20261014000700_vtid_05151_seed_legacy_tenant_landing.sql` | C / VTID-05151 (M2) | #7 | `docs/validation/VTID-05151/rollback-seed.sql` | right after #7 | applied 2026-10-13 (RUN-MIGRATION 38459959764), post-check clean (post_login_path maxina /onboarding/welcome, alkalma /home; 2-row snapshot) |
| 9 | `20261101110000_mt_launch_tenant_pack_intake.sql` | mt-launch pack-intake-db / VTID-05324 (P1) | **WS5 `tenant_content_overrides` (mt-packs) row applied first**; all M0/M1 rows above; live `tenants(tenant_id)` (the migration refuses without it) | `docs/validation/VTID-05324/rollback-pack-intake.sql` (DROP both tables + function; expand-only, no data outside them) | after WS5's `tenant_content_overrides`; `docs/validation/VTID-05324/pre-check.sql` first, `post-check.sql` (P1 section) after | pending |
| 10 | `20261101110100_mt_launch_tenant_content_pipeline.sql` | mt-launch pack-intake-db / VTID-05324 (P2+P3) | #9 (the migration refuses without `tenant_pack_intake`) | `docs/validation/VTID-05324/rollback-pack-intake.sql` | right after #9; `post-check.sql` (P2+P3 section) after — `get_tenant_launch_readiness` returns for maxina | pending |
| 11 | `20261101090000_vtid_05245_tenant_email_branding.sql` (repo **vitana-v1**) | mt-frontend-brand/email-brand-db / VTID-05245 | — (independent; expand only; reads `public.tenants`, seeded with Maxina's current email branding) | vitana-v1: `docs/validation/VTID-05245/rollback.sql` | applied by Claude via RUN-MIGRATION after the vitana-v1 PR merges, before email-brand-code deploys; vitana-v1 `docs/validation/VTID-05245/pre-check.sql` first, `post-check.sql` after | queued |

Rows 1 and 5–8 are the agreed order from the sparred lane plans; each lane's own
PR confirms or corrects its rows (file names, rollback paths).

## Notes

- S-M's planned version `20261013200000` was already used by `20261013200000_vtid_05143_unified_card_system.sql`; S-M uses `20261013233000` instead (resolved 2026-10-13).
- Lane A rollback order: gateway revert → R2 → R1. R3 is independent.
- `reserved_tenant_slugs` (row 5) is listed in `scripts/ci/migration-drift-baseline.json` while row 5 is unapplied, so MIGRATION-DRIFT-CHECK does not fail the PR that adds it. Remove it from the baseline in the PR after the apply (the check then reports it as recovered). Removed 2026-10-13 after row 5 was applied.
- Rows 9–10 (VTID-05324) depend on WS5's `tenant_content_overrides` migration (mt-packs), which has no row here yet: mt-packs adds it above row 9 in its own PR, and rows 9–10 are not applied before it. `tenant_pack_intake` and `tenant_content_pipeline` are listed in `scripts/ci/migration-drift-baseline.json` while unapplied; remove them in the PR after the apply.
