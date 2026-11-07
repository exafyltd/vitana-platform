# VTID-05572 — mt-data-cleanup-r2 / profiles-tenant-backfill

Plan: `.kiro/specs/mt-data-cleanup-r2/plan.md` (Fix item 3, premise 4) and the `profiles-tenant-backfill` group of
`tasks.md` (P1-P5). Sparring record: `plan-sparring.md`.

VALIDATION_PROFILE: database (migration files and read-only SQL only).
ROUTE_MOUNT: none. FINAL_URL: n/a. Nothing is applied from the PR; each file is applied later through
`RUN-MIGRATION.yml`, one dispatch per file, after the owner approves the files and the target database
(collaboration.md §7d). Kiro ran no SQL against any live system; the local runs below are in-process PGlite.

Change types: Database, Tooling/docs.

## Files

| Task | File |
|---|---|
| P1 objects: snapshot, log and review-list tables, backfill and restore functions (no data) | `supabase/migrations/20261102042000_vtid_05572_profiles_tenant_backfill_fn.sql` |
| P1 apply: snapshot, backfill, assert | `supabase/migrations/20261102042100_vtid_05572_profiles_tenant_backfill_run.sql` |
| P2 rollback (run only through RUN-MIGRATION after owner approval; not under `supabase/migrations`) | `rollback-042100-profiles-tenant-backfill.sql` |
| P3 read-only checks | `pre-check.sql`, `post-check.sql`, `rollback-check.sql` |
| P4 pgTAP (22 cases) | `supabase/tests/vtid_mt_data_cleanup_profiles_tenant_backfill.test.sql` |
| P5 | `docs/multitenancy/MIGRATION-QUEUE.md` rows 41-42 |

Apply order: 042000 → 042100, after the membership unification (queue rows 14-16). Rollback: restore function via
`rollback-042100-profiles-tenant-backfill.sql`, then `rollback-check.sql`.

## Acceptance

AC-1 A member with exactly one `user_tenants` row gets that tenant in `profiles.tenant_id`; a profile that already has a
tenant is never overwritten; the bot user and `service_bot_accounts` are never backfilled.
TEST: pgTAP cases 3, 6 and 7 in `supabase/tests/vtid_mt_data_cleanup_profiles_tenant_backfill.test.sql`.

AC-2 A member with no membership or two memberships stays NULL, is listed in `legacy_archive.mt_profiles_tenant_unresolved`
with the reason and the count, and nobody is defaulted to Maxina or to a tenant they are not a member of.
TEST: pgTAP cases 4, 5, 8, 9, 10, 11, 12 and 13 in `supabase/tests/vtid_mt_data_cleanup_profiles_tenant_backfill.test.sql`.

AC-3 The snapshot is taken first, keeps the first capture, and a second run is a no-op; the column stays nullable.
TEST: pgTAP cases 14, 15, 16 and 17 in `supabase/tests/vtid_mt_data_cleanup_profiles_tenant_backfill.test.sql`.

AC-4 The rollback restores the snapshot value for exactly the profiles the backfill set, keeps a later change, and the
functions are not executable by anon or authenticated.
TEST: pgTAP cases 1, 2, 18, 19, 20, 21 and 22 in `supabase/tests/vtid_mt_data_cleanup_profiles_tenant_backfill.test.sql`.

AC-5 The apply file asserts after the backfill: every backfilled profile holds its single membership tenant and no
single-membership profile is left NULL; the read-only pre/post/rollback checks report the counts.
TEST: `node docs/validation/VTID-05572/pglite-harness/checks.mjs` output in `outputs/read-only-checks-pglite.txt`
(post-check: bad_backfilled 0, bad_single_membership_still_null 0; rollback-check: all 0).

AC-6 The pgTAP file is red on `origin/main` and green with the lane migration; it inserts its own rows and never depends
on harness-only rows or absolute counts.
TEST: `outputs/pgtap-profiles-backfill-RED-on-faf6921a83.txt` (SQL error, function/table absent) and
`outputs/pgtap-profiles-backfill.txt` (22 ok, 0 not ok).

AC-7 The staging manifest is valid and honest: nothing deployed reads the change.
TEST: `outputs/staging-manifest-validation.txt` (`validateManifest` → ok true).
