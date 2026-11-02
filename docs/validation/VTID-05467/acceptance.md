# VTID-05467 — mt-identity-r2 / role-source-and-bootstrap

Plan: `.kiro/specs/mt-identity-r2/plan.md`, lane 4 (role-source-and-bootstrap). Plan amendment 1 changed lanes 1 and 2
only, so lane 4 is as converged. Tasks: the `role-source-and-bootstrap` group of `tasks.md` (R1–R3). Sparring record:
`docs/validation/VTID-05467/plan-sparring.md`.

VALIDATION_PROFILE: database (migration files and pgTAP only). ROUTE_MOUNT: none. Change types: Database.
Nothing is applied from the PR. Each migration is applied later through `RUN-MIGRATION.yml`, one dispatch per file, only
after the owner approves the files and the target database (collaboration.md §7d; staging shares the production
database). No live system was connected. Checks ran on an in-memory Postgres (PGlite) over a stub schema.

## Files

| Task | File |
|---|---|
| R1 snapshot, derivation, write-path contract, self-checks | `supabase/migrations/20261102033000_vtid_05467_single_role_source.sql` |
| R2 bootstrap_admin_user on the default tenant | `supabase/migrations/20261102033100_vtid_05467_fix_bootstrap_admin_user.sql` |
| R3 rollback (restores the three previous bodies) | `supabase/migrations/20261102033000_vtid_05467_role_source_rollback.sql` |
| pgTAP, single source (28 assertions) | `supabase/tests/mt_identity_roles_single_source.test.sql` |
| pgTAP, bootstrap (20 assertions) | `supabase/tests/mt_identity_roles_bootstrap.test.sql` |
| Read-only checks (SELECT only) | `docs/validation/VTID-05467/live-before.sql`, `docs/validation/VTID-05467/post-apply-checks.sql` |
| PGlite check and its stub schema | `docs/validation/VTID-05467/pglite-check.mjs`, `docs/validation/VTID-05467/fixture-stub.sql` |
| Outputs of the PGlite run | `docs/validation/VTID-05467/outputs/` |

Apply order: 20261102033000_vtid_05467_single_role_source → 20261102033100_vtid_05467_fix_bootstrap_admin_user, each in
its own dispatch. The rollback sorts before the forward files in replay order and is a no-op on a database without the lane.

## Acceptance criteria

AC-1: Only this lane's paths change: the three migration files, the two pgTAP files and `docs/validation/VTID-05467/`.
TEST: `git diff --name-only origin/main...HEAD` lists only those paths, and `git diff --name-only origin/main...HEAD | grep -E '^(\.kiro/|docs/multitenancy/|scripts/|services/)'` prints nothing.

AC-2: `user_tenants.active_role` is the selected role, and `role_preferences` is derived from it on insert and on every change of `active_role` (trigger `user_tenants_derive_role_preference`).
TEST: `supabase/tests/mt_identity_roles_single_source.test.sql` assertions 7–9 and 17–19, in `outputs/pgtap-after-apply.txt`.

AC-3: `user_permitted_roles` stays a separate grant store. Setting `active_role` to admin derives no grant row, the member's permitted set still has no admin, and no trigger or function in this lane writes the grant table. The permitted set is checked in SQL, the same way `lib/permitted-roles.ts` builds it; the gateway middleware itself is not run here.
TEST: single-source assertions 10–11 (`outputs/pgtap-after-apply.txt`); the self-check in `20261102033000` (`position('user_permitted_roles' IN v_src)` on the trigger body).

AC-4: The client roles `anon` and `authenticated` have no INSERT, UPDATE, DELETE or TRUNCATE privilege on `user_tenants`, `role_preferences`, `user_active_roles` and `user_permitted_roles`.
TEST: single-source assertions 3–6, and the privilege loop in the self-check of `20261102033000`.

AC-5: `set_role_preference` and `me_set_active_role` write the selected role to `user_tenants`, keep every check of their previous bodies, and keep writing the Command Hub copy `user_active_roles` in the same transaction.
TEST: single-source assertions 17–25 (`outputs/pgtap-after-apply.txt`); the self-checks read the function bodies.

AC-6: A switch with no membership row writes nothing. `set_role_preference` raises 42501 "Not a member of this tenant" (an exafy admin included), and `me_set_active_role` returns `NOT_A_MEMBER` before any write.
TEST: single-source assertions 15–16 and 26–28 (`outputs/pgtap-after-apply.txt`).

AC-7: Snapshot first. `legacy_archive.bak_05467_user_tenants`, `…_role_preferences` and `…_user_active_roles` hold the apply-time rows, are readable by the service role only, and are dropped by the rollback.
TEST: `outputs/pglite-apply.txt` reads `snapshots: {"ut":2,"rp":2,"uar":1}`; `post-apply-checks.sql` counts the three snapshots.

AC-8: Apply moves no data: no selected role and no preference value changes when the forward migration runs (no backfill). The current disagreement is counted by `live-before.sql` for the owner.
TEST: `outputs/pglite-apply.txt` shows the member rows identical before and after apply; `live-before.sql` ran on the applied stub (counts in the commands log).

AC-9: `bootstrap_admin_user` keeps its signature `(p_user_id uuid, p_user_email text)`, pins no tenant name, keys on `tenants.is_default`, and grants admin (memberships role admin, status active) in the default tenant only.
TEST: `supabase/tests/mt_identity_roles_bootstrap.test.sql` assertions 2–4, 7–8, 12 and 16 (`outputs/pgtap-after-apply.txt`); the self-check in `20261102033100`.

AC-10: The bootstrap writes the canonical `user_tenants` row at once, sets no selected role (`community` for a new row), and leaves an existing row's selected role alone.
TEST: bootstrap assertions 9–11 (`outputs/pgtap-after-apply.txt`).

AC-11: The bootstrap refuses a non-exafy caller, a second bootstrap of an admin, a target with no `app_users` row, and an unknown user. A refusal writes no membership and no `user_tenants` row.
TEST: bootstrap assertions 5, 17–20 (`outputs/pgtap-after-apply.txt`).

AC-12: Red before the fix. The new pgTAP files fail on the previous bodies, and the previous bootstrap fails with its own errors: `column "id" does not exist` on the tenant_id key shape, and `type "tenant_role" does not exist` on the id key shape.
TEST: `outputs/pglite-red-base.txt` (the red-base section) and `outputs/pglite-variant-id.txt` (the id variant, red before apply).

AC-13: The rollback restores `bootstrap_admin_user`, `set_role_preference` and `me_set_active_role` verbatim, removes the trigger and its function, restores `user_tenants.active_role` from the snapshot, and drops the three snapshots. The catalog fingerprint after rollback equals the base.
TEST: `outputs/pglite-rollback.txt`: "rollback restores the catalog exactly", and the switched member's selected role goes back to `community`.

AC-14: On a database without the lane the rollback is a no-op (replay order): the catalog fingerprint is unchanged.
TEST: `outputs/pglite-rollback-noop.txt`.

AC-15: After the rollback the forward files apply again, and both pgTAP files pass again.
TEST: `outputs/pgtap-after-reapply.txt`.

AC-16: Both key shapes work: `tenants` keyed by `tenant_id` (the 2026 migrations and fixtures) and keyed by `id` (the 2025 DDL). The lane does not decide which one is live (see the premises below).
TEST: `outputs/pglite-summary.txt` reads ALL CHECKS PASSED; `outputs/pglite-variant-id.txt` shows both files passing on the id shape.

AC-17: The derivation is tested, not assumed. With the trigger dropped after apply, the single-source file fails.
TEST: `outputs/pglite-negative-control.txt` (8 failing assertions).

AC-18: The two read-only check files contain only SELECT statements.
TEST: `grep -n -i -E '^\s*(insert|update|delete|drop|alter|create|truncate|grant|revoke|do|call|perform)\b' docs/validation/VTID-05467/live-before.sql docs/validation/VTID-05467/post-apply-checks.sql` prints nothing.

AC-19: The migrations add no table other than the three snapshots, no column, no index, and no signature change. The impact scan reports no blocker and no warning.
TEST: `IMPACT_SCAN_BASE=origin/main node scripts/ci/dev-autopilot-impact-scan.mjs` in the worktree after the commit reports `blocker=0 warning=0` (commands.log).

AC-20: No gateway file changes. `npm run test:roles` (42h) was not run in this worktree (no `services/gateway/node_modules`); CI runs it.
TEST: `git diff --name-only origin/main...HEAD | grep '^services/'` prints nothing; `services/gateway/test/vtid-04560-role-separation-regression.test.ts` reads `20260925120000` and `20260926150000` by name (lines 459–473 and 1013–1028), and this lane changes neither file.

AC-21: The staging manifest is valid. It names the existing role suite and claims no staging test.
TEST: `validateManifest(docs/validation/VTID-05467/staging-tests.json)` returns `{"ok":true}` (commands.log).

AC-22: `docs/multitenancy/MIGRATION-QUEUE.md` and `scripts/ci/migration-drift-baseline.json` are not touched. The `drift` check fails on the three new snapshot tables until lane `migration-records` lands; that failure is expected.
TEST: `git diff --name-only origin/main...HEAD | grep -E 'MIGRATION-QUEUE|migration-drift-baseline'` prints nothing.

## Decisions taken (for the owner; each is the most conservative reading of the plan)

1. **No backfill of `user_tenants.active_role`.** The plan says the selected role is `user_tenants.active_role`. No switch
   path has ever written that column, so its live value is the insert-time default (`community`), with one migration-time
   `developer` row (20251231000000_vtid_01101_phase_a_bootstrap.sql:318). The switches write `role_preferences` and
   `user_active_roles`. Aligning the column to `role_preferences` would change the input that the gate reads for users who
   did nothing. This lane therefore moves no data; from the first switch on, both stores are written in one step. The
   counts in `live-before.sql` decide whether the owner wants a backfill, and in which direction.
2. **Gate effect (owner decision).** A permitted tenant admin who selects admin in the Command Hub now has
   `user_tenants.active_role = admin` and a grant, so `requireTenantAdmin` admits them (its rule (b)). Before this lane no
   switch wrote the column, so only exafy admins passed. The community app's switch still refuses admin for non-exafy
   users (`Admin role can only be assigned by super administrators`). `me_set_active_role` has no such refusal: it relies on the
   grant check (`check_role_permitted`), which is unchanged. The owner should confirm this widening.
3. **`user_active_roles` is not derived.** It has no tenant key and the plan does not name it. Both switch functions still
   write it in the same transaction. A later lane should decide whether it follows the primary membership.
4. **The bootstrap grant is a memberships row, and the canonical row is written explicitly.** The grant store that the gate
   and the policies read today is `memberships` (plan amendment 1). The `user_tenants` row is inserted in the membership
   dual-write shape (`ON CONFLICT (tenant_id, user_id) DO NOTHING`), so it exists at once and does not depend on the
   dual-write trigger of lane `membership-unification`. The bootstrap sets no selected role.
5. **New refusal in the bootstrap:** a target without an `app_users` row is refused before any write. The old body wrote
   memberships without that row. `user_tenants.user_id` references `app_users`, so the canonical row could not be written.
6. **Exafy admins need a membership row to switch.** `set_role_preference` and `me_set_active_role` used to write a
   preference row for any tenant an exafy admin named. Now the switch writes the canonical row, so a non-member gets 42501 or
   `NOT_A_MEMBER`. The same holds for a permitted user with a grant but no membership.
7. **Snapshot scope.** The rollback restores the selected role of the memberships that still exist, drops the trigger first,
   and keeps `role_preferences` as it is. The preference row is the current selection that the community app and the ORB
   read. A preference row created by the trigger after apply is kept, for the same reason.
8. **Derivation on insert overwrites.** A membership created again starts at `community` in both tables. Before this lane a
   stale preference row could survive a re-created membership. This is the strict reading of "derive".
9. **Tenant key.** The bootstrap reads the default tenant's key with `coalesce(to_jsonb(t) ->> 'tenant_id', to_jsonb(t) ->> 'id')`,
   so it works on either shape and does not decide the question (premise 3).
10. **Escapes.** `-- impact-allow-solo-migration` is set in the forward and rollback files, with the reason.

## Premises that turned out false or unverified

1. **"user_tenants.active_role is the selected role" (plan, R1).** False for existing data: no switch writes it (grep of
   every migration for a `SET active_role` on `user_tenants`). The lane makes it the one source from the first switch on; decision 1 covers the rest.
2. **"bootstrap_admin_user writes memberships and keys on the tenant name" (plan, R2).** True: vitana-v1
   20250915132930 lines 166–265 (names at :200, :217, :236, :246, :254; memberships at :233–240). In addition, the body
   cannot run under its own `SET search_path = ''`: `'admin'::tenant_role` does not resolve the public enum. The PGlite
   red run shows `type "tenant_role" does not exist`. The live function may differ from the file; this cannot be checked
   without a connection, which the lane does not make.
3. **Primary key of `tenants` (not stated in the plan).** The canonical DDL says `id` (20251231000000_vtid_01101_phase_a_bootstrap.sql:30).
   The 2026 migrations (for example 20261014000200_vtid_05149_signup_default_tenant.sql:120), the fixtures
   `supabase/tests/vtid_05147_fixture.sql`, `vtid_05150_fixture.sql` and `vtid_05151_fixture.sql`, and the 05147 live copies use `tenant_id`.
   `20260528130000_BOOTSTRAP_fix_longevity_stub_tenants_column.sql` says the canonical file has no `tenant_id`. The owner must
   confirm the live column before the bootstrap is applied. Both shapes are tested.
4. **Dependency on `membership-unification` (plan, R2 "through the dual-write path").** The dual-write trigger is not on
   `origin/main` yet. The bootstrap writes the canonical row explicitly, so it does not need the trigger. The apply order still
   puts this lane after `membership-unification`.
5. **`npm run test:roles` is green (lane acceptance).** Not run here, because `services/gateway/node_modules` is absent. The
   suite reads historical migrations by name, so the new files cannot change its input (AC-20).
6. **Local stack (lane acceptance: "apply and roll back clean on the local stack").** Not run: Docker is not available. The
   PGlite run applies to a stub schema (`fixture-stub.sql`), which models the live shape from the 05147 fixture. It is not the live catalog.
7. **`auth.users` in the pgTAP files.** The tests insert auth rows directly. If the local stack has triggers on `auth.users`,
   the bootstrap test removes the rows they might add for user Z. This is an assumption about the local stack.

## Not run here

- `supabase test db` and `supabase db reset` (no Docker). The pgTAP files are written for pg_prove and ran through the PGlite shim.
- Any read or write against a live database, RUN-MIGRATION, and any dispatch. All of them need owner approval first.
- `npm run test:roles` (no gateway `node_modules`).
