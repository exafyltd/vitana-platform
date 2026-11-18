# VTID-05491 — mt-tenant-admin-r2 / tenant-admin-moderation-db

Plan: `.kiro/specs/mt-tenant-admin-r2/plan.md` (Fix item `tenant-admin-moderation-db`, Migrations, Tests) and the
`tenant-admin-moderation-db` group of `tasks.md` (M1-M5). Design: `design.md` section "tenant-admin-moderation-db (O4)".
Sparring record: `plan-sparring.md`.

VALIDATION_PROFILE: gateway_backend (migration files, pgTAP, read-only SQL and one static test; the PR body and the validator guard use this profile).
ROUTE_MOUNT: none. FINAL_URL: n/a. Nothing is applied from the PR; each file is applied later through
`RUN-MIGRATION.yml`, one dispatch per file, after the owner approves the files and the target database
(collaboration.md §7d). Kiro ran no SQL against any live system; the local runs below are in-process PGlite.

## Files

| Task | File |
|---|---|
| M1 P2 tenant columns, snapshot, backfill, helpers, stamping trigger | `supabase/migrations/20261102070100_vtid_05491_mt_tenant_admin_p2_moderation.sql` |
| M2 P3 tenant-scoped RPCs + review guard | `supabase/migrations/20261102070150_vtid_05491_mt_tenant_admin_p3_moderation.sql` |
| M3 moderator tenant-scope policies | `supabase/migrations/20261102070600_vtid_05491_mt_moderator_tenant_scope.sql` |
| rollbacks | `rollback-070600-…`, `rollback-070150-…`, `rollback-070100-…` (apply in that order) |
| read-only checks | `live-before.sql`, `post-apply-checks.sql`, `rollback-check.sql` |
| M4 pgTAP | `pgtap/vtid_05491_tenant_moderation.test.sql` (73 cases) + `pgtap/vtid_05491_fixture.sql` |
| M5 queue / drift | `docs/multitenancy/MIGRATION-QUEUE.md` rows 34-36; `scripts/ci/migration-drift-baseline.json` unchanged (no new public table: the only new tables are in `legacy_archive`, which the drift check ignores) |
| static gate | `static/vtid-05491-tenant-moderation.test.ts` (20 cases; run locally with ts-jest, see `commands.log`; staging-tests.json uses a read-only http probe because the STAGING-VERIFY `existing` runner only accepts `npm run` / `npx jest` refs rooted in a package) |

Apply order: 070100 → 070150 → (C3 `070160`, mt-community-isolation-r2, not here) → 070600. Rollback order: 070600 → 070150 → 070100
(each earlier rollback refuses while a later file is still applied). The queue row numbers 34-36 may shift at landing: rows 30-31 belong to VTID-05507 (tenant-domains-db, merged) and rows 32-33 to VTID-05493
(tenant-lifecycle-db, PR #4788); the C3 `070160` ordering note is unchanged.

## Acceptance

AC-1 (M1) `content_reports.tenant_id` and `moderation_actions.tenant_id` (uuid, NULL allowed, FK to tenants ON DELETE SET NULL).
The pre-change rows are snapshotted into `legacy_archive.bak_05491_*` before any update. Backfill is unambiguous-only: a report
takes its reporter's primary (or only) tenant, an audit row the tenant of its target; ambiguous or unknown rows stay NULL. No
policy, grant or existing function changes in this file.
TEST: pgTAP cases 2-11 and the `P2` backfill/snapshot cases; static test "P2 snapshots before it moves data".

AC-2 (M1) `is_tenant_moderator(tenant)` is true for the exafy_admin claim or an active staff/admin membership in THAT tenant, false
for another tenant, a plain member and a NULL tenant (non-exafy). `moderation_home_tenant(user)` is not executable by anon or
authenticated. A new report is stamped with the reporter's home tenant; naming a tenant the reporter is not a member of raises
`TENANT_NOT_MEMBER`; an ambiguous reporter is stored with a NULL tenant.
TEST: pgTAP cases 12-28.

AC-3 (M2) `moderation_list_reports(tenant, status, limit)` returns exactly one tenant's reports to its moderator, refuses another
tenant's moderator (`NOT_AUTHORIZED`), makes the all-tenants (NULL) listing exafy_admin only, applies the status filter and clamps the
limit. `moderation_resolve_report(...)` sets status/action/notes/reviewer, writes exactly one tenant-stamped audit row, is idempotent
(the same call again writes no second audit row), and refuses a foreign tenant's moderator, a NULL-tenant report for a tenant
moderator (exafy_admin may), an unknown status (`BAD_STATUS`), an unknown id (`REPORT_NOT_FOUND`) and anon (42501).
The review guard keeps `tenant_id` assign-once.
TEST: pgTAP cases 29-52.

AC-4 (M3) With the per-tenant flag `mt.moderator_tenant_scope` off, a moderator of any tenant reads and updates exactly what they did
before (the legacy any-tenant test). With it on, a moderator of T_B sees 0 T_A reports and 0 T_A audit rows and updates 0 T_A reports,
sees and updates their own tenant's, sees no NULL-tenant row; exafy_admin still sees everything; a plain member sees nothing; a tenant
whose flag is off stays legacy (per-tenant rollout). The policies keep their names, the INSERT policy is untouched, and no policy uses
a bare `current_tenant_id()`.
TEST: pgTAP cases 53-73; static test "scope migration keeps the policy names".

AC-5 (M1-M5) each migration is idempotent, runs `SET LOCAL lock_timeout = '3s'` with up to 5 retries on `lock_not_available`, one
transaction; three rollbacks that restore the prior state and refuse out of order, three SELECT-only check files, queue rows 30-32
(`queued (pending owner approval)`), nothing destroys data.
TEST: `outputs/read-only-checks-and-rollback-pglite.txt`, `outputs/pgtap-green-applied-twice.txt`, the static test.

## Evidence (all local, PGlite = PostgreSQL 18 wasm; `pglite-harness/`)

| Run | Result |
|---|---|
| `outputs/pgtap-green.txt` | 73 ok, 0 not ok |
| `outputs/pgtap-green-applied-twice.txt` | 73 ok: all three migrations applied twice (idempotent) |
| `outputs/pgtap-red-no-migrations.txt` | RED: SQL error, no lane object exists (origin/main state) |
| `outputs/pgtap-red-without-scope-migration.txt` | RED: SQL error with 070100 and 070150 applied but not 070600 |
| `outputs/read-only-checks-and-rollback-pglite.txt` | live-before, migrations, post-apply-checks, rollbacks, rollback-check, re-apply, re-rollback, and the out-of-order guard |
| `outputs/jest-vtid-05491-red-on-origin-main.txt` | RED: 20 failed, the static test on a clean origin/main |
| `outputs/jest-vtid-05491-green.txt` | 20 pass |

## Deviations and limits (honest record)

* **Test locations.** The lane's `paths` do not include `supabase/tests/` or `services/gateway/test/`, and Lane scope rejects a file outside
  `paths`, so the pgTAP file, its fixture and the static test live under `docs/validation/VTID-05491/` (exempt). CI's
  `supabase test db` does not pick that pgTAP file up; the PGlite run is the evidence, and the owner can run it with `supabase test db`
  locally.
* **PGlite is not the production schema.** `base_schema.sql` holds stand-ins; `content_reports`, `moderation_actions`,
  `is_community_moderator()` and the three policies are copied from vitana-v1 migrations `20251010065205` and `20260622120000`.
  The real `memberships.role` enum is `tenant_role`; the stand-in models it.
* **user_suspensions and the legacy moderator RPCs** (`moderate_profile_post`, `set_user_suspension`) keep their global
  `is_community_moderator()` check. They are not tenant-scoped here: `user_suspensions` has no tenant column and the post RPCs live in
  vitana-v1 migrations. Tracked as a follow-up with mt-community-isolation-r2 (C3) and the gateway lane `tenant-admin-api`.
* **No gateway change.** Nothing calls the new RPCs until the gateway lane; `admin-moderation.ts` still returns `[]`.
