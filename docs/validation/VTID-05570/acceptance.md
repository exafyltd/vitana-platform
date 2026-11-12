# VTID-05570 — mt-data-cleanup-r2 / memory-facts-supersede-merge

Plan: `.kiro/specs/mt-data-cleanup-r2/plan.md` and the `memory-facts-supersede-merge` group of `tasks.md` (M1-M5).
Sparring record: `plan-sparring.md`.

VALIDATION_PROFILE: gateway_backend (migration files and read-only SQL only).
ROUTE_MOUNT: none. FINAL_URL: n/a. Nothing is applied from the PR; each file is applied later through `RUN-MIGRATION.yml`,
one dispatch per file, after the owner approves the files and the target database (collaboration.md §7d). Kiro ran no SQL
against any live system; the local runs are in-process PGlite (`pglite-harness/`).

## Files

| Task | File |
|---|---|
| M1 merge + M2 restore functions | `supabase/migrations/20261102041000_vtid_05570_memfacts_merge_functions.sql` |
| M2 pre-approved rollback | `supabase/migrations/20261102041100_vtid_05570_memfacts_merge_rollback.sql` |
| M1 apply (snapshot, merge, assert) | `supabase/migrations/20261102041200_vtid_05570_memfacts_merge_run.sql` |
| M4 pgTAP | `supabase/tests/vtid_mt_data_cleanup_memfacts_supersede_merge.test.sql` (29 cases) |
| M3 read-only checks | `pre-check.sql`, `post-check.sql`, `rollback-check.sql` |
| M5 | `docs/multitenancy/MIGRATION-QUEUE.md` rows 37-39 |

## Acceptance

AC-1 A duplicate (tenant_id, user_id, fact_key, entity) group collapses to exactly one current fact; the newest
`extracted_at` wins (id breaks a tie); losers get `superseded_by` = winner and `superseded_at`; nothing is deleted.
TEST: pgTAP cases 7-15 and 23 in `supabase/tests/vtid_mt_data_cleanup_memfacts_supersede_merge.test.sql`.

AC-2 A lone fact, an already-superseded row, and a 'self' vs 'disclosed' pair of the same key are untouched; the same key
for another user or tenant is its own group.
TEST: pgTAP cases 16-22 in `supabase/tests/vtid_mt_data_cleanup_memfacts_supersede_merge.test.sql`.

AC-3 A second merge changes nothing (idempotent).
TEST: pgTAP cases 24-25 in `supabase/tests/vtid_mt_data_cleanup_memfacts_supersede_merge.test.sql`.

AC-4 Rollback restores: `mt_memfacts_restore()` returns every snapshotted row to its pre-merge `superseded_by` /
`superseded_at` (the duplicates are current again) and is a no-op while no snapshot exists.
TEST: pgTAP cases 5-6 and 26-27 in `supabase/tests/vtid_mt_data_cleanup_memfacts_supersede_merge.test.sql`.

AC-5 `mt_memfacts_merge()` and `mt_memfacts_restore()` are not executable by anon/authenticated (service_role only).
TEST: pgTAP cases 3-4 in `supabase/tests/vtid_mt_data_cleanup_memfacts_supersede_merge.test.sql`.

AC-6 The test was red before the migrations existed (function missing) and is green after.
TEST: `outputs/pgtap-memfacts-RED-on-origin-main.txt` and `outputs/pgtap-memfacts.txt` (commands in `commands.log`).

AC-7 The snapshot table is created on demand (no file declares it, so the drift baseline is untouched), keeps the first
capture, is RLS-enabled and service_role only.
TEST: `scripts/ci/check-migration-drift.test.cjs` (node --test) and pgTAP cases 28-29 (merge after restore).
