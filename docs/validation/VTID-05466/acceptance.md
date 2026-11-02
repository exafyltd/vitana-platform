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
| Logic proof | `pglite-migration-check.mjs`, `outputs/pglite-migration-check.txt` |

Apply order: 031000 → 031100 → 031200 (one dispatch each). The rollback sorts before the forward files in
replay order and is a no-op on a database without the lane (proven).

## Acceptance bullets → evidence

| Acceptance bullet (tasks.md) | Evidence | Result |
|---|---|---|
| Change types: Database | only `supabase/migrations/**`, `supabase/tests/**`, `docs/validation/VTID-05466/**` | met |
| Dual-write keeps `memberships` and `user_tenants` in sync | `memberships_dualwrite_user_tenants` (CONSTRAINT trigger, AFTER INSERT, DEFERRABLE INITIALLY DEFERRED) writes `user_tenants … ON CONFLICT (tenant_id, user_id) DO NOTHING` for active non-bot rows; dualwrite pgTAP (legacy insert lands; existing row, writer order, re-insert are no-ops); PGlite committed writes on a second database | met |
| The drift report reads 0 | `membership_drift_report()`: `drift: 0` on the converged mirror after M1 (PGlite); memberships → user_tenants stays 0 with the dual-write live (PGlite, committed writes); drift pgTAP | met |
| pgTAP: the four side-effect triggers do not fire on the backfill | backfill file: four `is(…, 0)` + positive control (an unsuppressed primary insert does fire) | met (shim run) |
| … or on a re-insert of an existing row (0 welcome chats, founding seats, autopilot rows, live rooms) | backfill file (second run, ON CONFLICT re-insert); dualwrite file: four `is(…, 0)`, "no user got any side effect", re-insert of an existing `memberships` row adds no row and no side effect. Negative control: removing the suppression from M2 fails exactly these assertions | met |
| A bot-user insert yields 0 `chat_messages` | backfill and dualwrite files: a bot `memberships` insert writes no `user_tenants` row and no `chat_messages`; service account, inactive, deleted-before-commit and no-`app_users` inserts write nothing | met |
| Amendment 1: no grant is written or derived | M2 writes `active_role 'community'` only and never reads `memberships.role`; dualwrite pgTAP: a `role 'admin'` legacy row gives `active_role community`, `memberships.role` unchanged, `user_permitted_roles` + `role_preferences` + `user_active_roles` row count unchanged; in-migration AC-5 self-check | met |
| The migrations apply and roll back clean on the local stack | PGlite: apply → rollback (exact prior state: rows, comment, functions, tables, trigger) → re-apply → rollback; all three pgTAP files pass after each apply | met on PGlite; **local Supabase stack not run** (no Docker here) |
| Nothing is applied from the PR | no workflow, no session write; `live-before.sql` / `post-apply-checks.sql` are SELECT-only | met |
| M1: exclude bot `…0001` and every `service_bot_accounts` user from the backfill and the drift counts | `cand` predicate in `mt_backfill_memberships_to_user_tenants()`, M2's early returns, every count in `membership_drift_report()`; in-migration abort if the backfill log holds one | met |
| M1: re-verify the counts read-only | `live-before.sql` (RUN-MIGRATION pre-check); the migration aborts above 30 rows or on a stranded user | prepared (live reads are not done from a session) |
| M3: MIGRATION-QUEUE rows | owned by lane `migration-records` (Amendment 1); not touched here | n/a for this lane |
| PR title `VTID-05466 (mt-identity-r2/membership-unification): …` | caller | n/a here |

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
