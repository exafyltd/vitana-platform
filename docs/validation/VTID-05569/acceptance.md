# VTID-05569 - mt-data-cleanup-r2 / hot-tables-not-null-expand-contract

Plan: `.kiro/specs/mt-data-cleanup-r2/plan.md` (Fix item `hot-tables-not-null-expand-contract`) and the group of the same name in
`tasks.md` (H1-H6). Sparring record: `plan-sparring.md`.

VALIDATION_PROFILE: gateway_backend (migration files, pgTAP and read-only SQL only).
ROUTE_MOUNT: none. FINAL_URL: n/a. Nothing is applied from the PR; each file is applied later through `RUN-MIGRATION.yml`, one
dispatch per file, after the owner approves the files and the target database (collaboration.md section 7d). Kiro ran no SQL
against any live system; the local runs below are in-process PGlite.

Change types: Database.

## Premise check (plan premise 5)

`tenant_id` is `NOT NULL` in the DDL of all three tables, and no later migration drops it:
`chat_messages` (`20260225200000_chat_messages.sql:8`), `user_notifications` (`20260225000000_notification_system.sql:27`),
`product_analytics_events` (`20260612140000_BOOTSTRAP_product_analytics_events.sql:33`). The only `DROP NOT NULL` on `chat_messages`
is `receiver_id` (`20260525000000_VTID_03089_chat_groups.sql:40`). The premise holds, so no re-plan is needed.

## Files

| Task | File |
|---|---|
| H1 assertion | `supabase/migrations/20261102043000_vtid_05569_hot_tables_tenant_not_null_assert.sql` |
| H3 no-op rollback | `supabase/migrations/20261102043100_vtid_05569_hot_tables_tenant_not_null_assert_rollback.sql` |
| H2 schema doc | `DATABASE_SCHEMA.md` (`product_analytics_events`, new `user_notifications / chat_messages` entry) |
| H4 read-only checks | `pre-check.sql`, `post-check.sql`, `rollback-check.sql` |
| H5 pgTAP | `supabase/tests/vtid_mt_data_cleanup_notnull_assert.test.sql` (11 cases) |
| H6 queue | `docs/multitenancy/MIGRATION-QUEUE.md` rows 51-52 |

Apply order: 043000 only (043100 is the rollback).

## Acceptance

AC-1 (H1) The forward migration is a read-only DO block: it RAISEs (`not_null_violation`) if `tenant_id` on `chat_messages`,
`user_notifications` or `product_analytics_events` is nullable per `information_schema` (or missing), and RAISEs
(`foreign_key_violation`) if any row's `tenant_id` is not in `tenants`. No trigger, no backfill, no default, no `SET NOT NULL`, no DDL.
TEST: pgTAP cases 1-11 in `supabase/tests/vtid_mt_data_cleanup_notnull_assert.test.sql` -> `outputs/pgtap-green.txt` (11 ok).

AC-2 (H5) The assertion passes on the real schema and fails loudly on a fixture with a nullable `tenant_id` (each table) and on a
fixture with a non-existent tenant (each table); each branch is needed.
TEST: `outputs/pgtap-RED-mutation-nullable-check-removed.txt` (cases 5-7 fail) and `outputs/pgtap-RED-mutation-orphan-check-removed.txt` (cases 8-10 fail).

AC-3 (H3) The rollback file is a no-op: it creates and drops nothing, and the three columns stay `NOT NULL` after it.
TEST: `pglite-harness/checks.sh` -> `outputs/read-only-checks-pglite.txt` (`rollback-check.sql`: both true).

AC-4 (H4) `pre-check.sql` reports `nullable` and `orphan_rows` per table, `post-check.sql` three booleans that must be true,
`rollback-check.sql` two. All are read-only. The migration refuses when an orphan row exists.
TEST: `outputs/read-only-checks-pglite.txt` and `outputs/refuses-on-orphan-pglite.txt` (the file RAISEs, pre-check shows `user_notifications | NO | 1`).

AC-5 (H2) `DATABASE_SCHEMA.md` records `tenant_id UUID NOT NULL` for `product_analytics_events` and for `user_notifications`, and says
`chat_messages` is NOT NULL too.
TEST: `git diff origin/main -- DATABASE_SCHEMA.md` (commands.log, section "docs").

AC-6 (H6) `docs/multitenancy/MIGRATION-QUEUE.md` rows 51-52 follow row 47 (rows 48-50 are reserved for VTID-05575) and name the
orphan and profiles rows as prerequisites; the bare-policy lint still passes (the files add no RLS policy); the staging manifest validates.
TEST: `outputs/jest-bare-policy-lint.txt` and `outputs/staging-tests-validate.txt`.

## Red on main, green on the branch

- Red: origin/main has neither the migration nor an assertion, so the same test file run with the assertion replaced by a no-op
  (what main does today) -> `outputs/pgtap-RED-on-origin-main-assertion-absent.txt` (5 ok, 6 not ok: cases 5-10).
- Red by mutation: nullable check removed (cases 5-7 fail); orphan check removed (cases 8-10 fail).
- Green: `outputs/pgtap-green.txt` (11 ok), the migration loaded before the test.
- The test body is a copy of the migration's DO block; `commands.log` records the byte check between the two.

## Decisions taken

- Timestamps `20261102043000` / `043100`, not the `060000-060900` the orchestrator suggested: the lane file's `paths`
  (`supabase/migrations/20261102043*.sql`), checked by Lane scope CI, allow only `043*`. No collision on main.
- Queue rows are 51-52 (main has 1-47; 48-50 are reserved for VTID-05575).
- The assertion reads `tenants` through both `tenant_id` and `id` when present (the same approach as the VTID-05571 live-tenant helper), so it
  works on production (`tenants.tenant_id`) and on the bootstrap schema.
- The assertion is a DO block, not a function, so the lane leaves no object behind; the pgTAP test therefore embeds a copy of the block.
- The rollback is a file with a NOTICE only (the queue contract needs one); it must never drop NOT NULL.
- `user_notifications` had no `DATABASE_SCHEMA.md` entry, so a new short entry was added next to `notification_type_controls`.
- PGlite stand-in for `product_analytics_events` is the real bootstrap DDL minus the `pgcrypto` extension line.
