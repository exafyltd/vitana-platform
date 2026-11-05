# VTID-05466 — mt-identity-r2 / membership-unification

Plan: `.kiro/specs/mt-identity-r2/plan.md` (Fix item 2, as changed by **Amendment 1**, commit `8a21d0455d`) and
the `membership-unification` group of `tasks.md` (M1–M3). Policy approval `converged-auto-v1`; sparring record
`docs/validation/VTID-05466/plan-sparring.md`.

VALIDATION_PROFILE: database (migration files only).
ROUTE_MOUNT: none. FINAL_URL: n/a. Nothing is applied from the PR; each file is applied later through
`RUN-MIGRATION.yml` after the owner approves the files and the target database (collaboration.md §7d).
CURL_PROOF: none possible without a write. OASIS_PROOF: no OASIS events.

## Files

| Task | File |
|---|---|
| M1 backfill, snapshot first, N1 suppression, bots excluded | `supabase/migrations/20261102031000_vtid_05466_user_tenants_canonical.sql` |
| M2 deferred dual-write (Amendment 1: `memberships` stays a table; file name kept) | `supabase/migrations/20261102031100_vtid_05466_memberships_view_dualwrite.sql` |
| M3 nightly drift report | `supabase/migrations/20261102031200_vtid_05466_membership_drift_report.sql` |
| Rollback (pre-approved; undoes 031200, then 031100, then 031000) | `supabase/migrations/20261102031000_vtid_05466_membership_unification_rollback.sql` |
| pgTAP | `supabase/tests/mt_identity_membership_backfill.test.sql` (24), `…_drift_report.test.sql` (18), `…_dualwrite.test.sql` (27) |
| Read-only checks | `live-before.sql`, `post-apply-checks.sql` |
| Logic proof (PGlite) | `pglite-migration-check.mjs`; outputs in `outputs/`: `pglite-apply.txt`, `pglite-rollback.txt`, `pglite-reapply.txt`, `pgtap.txt`, and the full run in `pglite-migration-check.txt` |

Apply order: 031000 → 031100 → 031200 (one dispatch each). The rollback sorts before the forward files in
replay order and is a no-op on a database without the lane (proven).

## Acceptance criteria

AC-1: Only database-scope files change: `supabase/migrations/**`, `supabase/tests/**` and `docs/validation/VTID-05466/**`. No workflow, script, rule file, MIGRATION-QUEUE or drift baseline changes.
TEST: `git diff --name-only origin/main...HEAD` lists only those paths, and the path-ownership gate of `scripts/ci/validate-pr-locally.cjs` passes (CI job `validate-pr`).
Result: met.

AC-2: The three forward migrations apply on PGlite (PostgreSQL 18.6, in memory) to a database without the lane. The backfill copies the one drifted member, skips the bot, fires no side effect and leaves the suppression setting off.
TEST: `pglite-migration-check.mjs <repo>` → `outputs/pglite-apply.txt`.
Result: met on PGlite. The local Supabase stack was not run (no Docker in this sandbox).

AC-3: The rollback restores the prior state exactly on PGlite: rows, the `user_tenants` comment, functions, tables and the dual-write trigger. On a database without the lane it is a no-op.
TEST: `pglite-migration-check.mjs <repo>` → `outputs/pglite-rollback.txt`.
Result: met.

AC-4: After the rollback the lane applies again, and a second rollback restores the prior state exactly.
TEST: `pglite-migration-check.mjs <repo>` → `outputs/pglite-reapply.txt` (re-apply) and the second-rollback line in `outputs/pglite-rollback.txt`.
Result: met.

AC-5: pgTAP passes through the PGlite shim for the backfill, drift report and dual-write files, after the apply and after the re-apply.
TEST: `pglite-migration-check.mjs <repo>` runs `supabase/tests/mt_identity_membership_{backfill,drift_report,dualwrite}.test.sql` → `outputs/pgtap.txt`.
Result: met on the shim. Real `supabase test db` is not run here (no Docker).

AC-6: The four primary-membership side-effect triggers do not fire on the backfill, or on a re-insert of an existing row: 0 welcome chats, 0 founding seats, 0 autopilot rows, 0 live rooms.
TEST: `supabase/tests/mt_identity_membership_backfill.test.sql` and `supabase/tests/mt_identity_membership_dualwrite.test.sql` (pgTAP, `outputs/pgtap.txt`); the line "M1 fired no side effect" in `outputs/pglite-apply.txt`.
Result: met.

AC-7: A bot or service-account membership writes no `user_tenants` row and no `chat_messages` row. The bot user `00000000-0000-0000-0000-000000000001` and every `service_bot_accounts` user are excluded from the backfill and from every drift count.
TEST: the lines "M1 did not backfill the bot" and "committed bot insert writes nothing" in `outputs/pglite-apply.txt`; the backfill and dual-write pgTAP files.
Result: met.

AC-8: The dual-write keeps `memberships` and `user_tenants` in sync at commit. A legacy-only insert creates a primary community row, the writer's own primary insert keeps its side effects, and a re-insert is a no-op.
TEST: `supabase/tests/mt_identity_membership_dualwrite.test.sql` (pgTAP); the "committed" and "writer order" lines in `outputs/pglite-apply.txt`.
Result: met on PGlite (committed writes on a second database).

AC-9: No grant is written or derived (Amendment 1). The backfill and the dual-write set `active_role` to `community` only, never read `memberships.role`, and leave the role tables unchanged. The migration self-checks that anon and authenticated have no write privilege on the membership and role tables.
TEST: `supabase/tests/mt_identity_membership_dualwrite.test.sql` (an `admin` legacy row gives `community`, and the role tables do not change); the self-check in `20261102031000` runs in every PGlite apply.
Result: met.

AC-10: The drift report reads 0 on the converged mirror, in both directions, and does not count bot rows.
TEST: `supabase/tests/mt_identity_membership_drift_report.test.sql`; the "drift" lines in `outputs/pglite-apply.txt`.
Result: met.

AC-11: The review fixes keep the meaning of the SQL. The four snapshot `CREATE TABLE` statements double-quote the schema name, and one comment is reworded. The catalog after apply, rollback and re-apply (tables, columns, constraints, indexes, functions, triggers, policies, grants, comments and row counts) is the same as before the edit.
TEST: `pglite-migration-check.mjs <repo>` on the edited files (`outputs/pglite-*.txt`). The catalog comparison before and after the edit was run in a scratch area; see `commands.log`.
Result: met.

AC-12: Nothing is applied from the PR. No workflow file changes, and both read-only check files contain only SELECT statements.
TEST: `! grep -n -i -E '^\s*(insert|update|delete|drop|alter|create|truncate|grant|revoke|do|call|perform)\b' docs/validation/VTID-05466/live-before.sql docs/validation/VTID-05466/post-apply-checks.sql` prints nothing.
Result: met.

AC-13: The impact scan reports no blocker and no warning. The rollback carries the documented `-- impact-allow-solo-migration` escape with a reason. The snapshot schema is double-quoted, so the duplicate-table-name rule (a bare-name regex) does not read it as a table.
TEST: `node scripts/ci/dev-autopilot-impact-scan.mjs`, run in this worktree, reports `blocker=0 warning=0`.
Result: met.

AC-14: The live count check is prepared but not run. `live-before.sql` re-verifies the backfill counts in the RUN-MIGRATION pre-check after the owner approves the files. No live read is made from a session.
TEST: the RUN-MIGRATION pre-check runs `docs/validation/VTID-05466/live-before.sql` after approval; AC-12 shows the file is SELECT-only.
Result: prepared; not run.

AC-15: MIGRATION-QUEUE rows and the drift baseline are owned by lane `migration-records` (Amendment 1) and are not in this PR. The drift check stays red until those land and `membership_drift_reports` is applied. That failure is expected.
TEST: `git diff --name-only origin/main...HEAD | grep -E 'MIGRATION-QUEUE|migration-drift-baseline'` prints nothing.
Result: met. CI job `drift` fails until then.

## Decisions taken
- Backfilled and dual-written rows get `active_role = 'community'`; `memberships.role` (a grant) never becomes
  the selected role (directive §5).
- Only `status = 'active'` rows are copied. The deferred trigger re-reads the row at commit, so a row deleted or
  deactivated in the same transaction is not copied.
- `is_primary` only when the user has no primary membership yet (the M1 / VTID-05043 rule), for both the
  backfill and the dual-write, so primary-tenant resolution stays defined for legacy-only members.
- The trigger is deferred because both legacy writers insert `memberships` first and their own primary
  `user_tenants` row after it (`20261010180200_vtid_05043_…:78,91`; `20261014000200_vtid_05149_…:130,201`). At
  commit the writer's row exists, so the dual-write is a no-op and the writer keeps its own side effects.
- The dual-write is fail-open: an error (e.g. FK) becomes a WARNING, the legacy writer commits, and the drift
  report counts the row. A user without `app_users` is skipped before the insert.
- The dual-write sets the suppression setting only around its own insert and restores the previous value.
- The backfill is a service-role-only function so pgTAP exercises the same code the migration runs.
- New tables (drift reports, four `legacy_archive` snapshots/logs) are service-role-only: REVOKE ALL FROM
  PUBLIC, anon, authenticated; GRANT ALL TO service_role; RLS on, no policy. Functions keep EXECUTE for
  service_role only.
- `drift` counts both directions; deleted-account rows and non-active rows are reported separately.
- The rollback drops everything the lane created (exact prior schema) and removes exactly the rows the backfill
  logged. `user_tenants` rows the dual-write wrote while it was live are kept: each matches a real
  `memberships` row, and deleting them would remove members from the canonical store.
- `MIGRATION-QUEUE.md` and `migration-drift-baseline.json` are left to lane `migration-records`.
- Impact-scan fixes (review of the CI run on the previous head). The snapshot `CREATE TABLE` statements double-quote
  the schema name `"legacy_archive"`. The duplicate-table-name rule reads the first name after the table keyword, so
  it took the schema for a table; `legacy_archive` is also created by 20261014000700. PostgreSQL resolves the quoted
  name to the same schema, and the catalog is unchanged (AC-11). `IF NOT EXISTS` was not used: this migration is
  not idempotent by design, and `IF NOT EXISTS` would change the second-run behaviour its header documents.
- The rollback carries the solo-migration escape `-- impact-allow-solo-migration` (AC-13). The objects it drops are
  read by no gateway, worker or frontend code (grep of `services/` and `src/`).
- The header of `20261102031000` now gives the apply order this PR contains (031000, 031100, 031200). It had said M2
  was outside this PR.

## Plan premises that turned out false
1. **"15 rows only in memberships"** (plan Problem 3, from program §2): stale. VTID-05043 Migration B
   backfilled the 3 real ones and VTID-05124 deleted the 12 deleted-account rows. Expected backfill today: 0.
2. **"`memberships` becomes a view over `user_tenants`"**: `memberships.role` is a grant store (about 50 RLS
   policies on 34 tables, `set_role_preference`, `get_my_permitted_roles`, gateway `permitted-roles.ts`), and
   `switch_to_tenant_by_slug`'s `INSERT … ON CONFLICT (user_id, tenant_id)` fails against an INSTEAD OF view
   (PG 18). Resolved by Amendment 1: the table stays, a deferred dual-write trigger is added, and the view
   cutover is a later, separately sparred lane.
3. **MIGRATION-QUEUE rows / drift baseline inside the DB lane**: both files are outside the lane's paths;
   Amendment 1 moved them to lane `migration-records`.

## Not run here
Real pgTAP (`supabase test db`) and the local stack: Docker does not start in this sandbox. The files are written
for pg_prove and pass through the PGlite shim. The gateway Jest guard in `staging-tests.json` runs in CI (this
worktree has no `node_modules`; the lane changes no gateway code).
