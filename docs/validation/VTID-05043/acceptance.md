# VTID-05043 - Tenant self-enrolment guard: migrations (Track S / S3, PR2)

Owner approval 2026-10-10 (Gate 1: "Yes approved"). Sparring: `plan-sparring.md` (converged, 3 rounds).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: none. This PR adds three SQL migrations (A guard + open_signup, B data fix-up, C RPC rewrite) and lands dark: no code reads `tenants.open_signup` and nothing is applied at merge.

FINAL_URL: n/a (database only). Staging shares the production database, so A -> B -> C are applied once, at the production step, through `RUN-MIGRATION.yml`, after the owner approves.

CURL_PROOF: none possible without a write. Behaviour is proven on PGlite (`pglite-migration-check.mjs`, `outputs/pglite-migration-check.txt`) and, after apply, by the read-only `post-apply-checks.sql`.

OASIS_PROOF: no OASIS events; no gateway state transition is added.

## Live facts used (read-only, 2026-10-10)

- `switch_to_tenant_by_slug` live body + grants and the four `user_tenants` triggers: `live-before.sql`.
- Drift: 15 active `memberships` rows without `user_tenants` (maxina 11, alkalma 4). 12 belong to user ids absent from both `auth.users` and `app_users` (deleted accounts); 3 are real alkalma users who already have a primary membership. Bad claims: 0. `auth.users` without `app_users`: 0.

## Acceptance criteria

AC-1: The four primary-membership triggers on `public.user_tenants` keep their names, timing and functions and gain `AND NOT public.membership_side_effects_suppressed()` in their WHEN clause; the guard is false unless the transaction-local setting is `on`.
  TEST: services/gateway/test/vtid-05043-s3-migrations.test.ts (Migration A)
  TEST: docs/validation/VTID-05043/pglite-migration-check.mjs ("A: every trigger carries the guard", "primary insert outside the fix-up fires all 4 side effects", "primary insert with the transaction-local setting fires nothing")

AC-2: `tenants.open_signup` exists (default false) and is true for exactly maxina and alkalma; the migration aborts unless exactly 2 rows were updated.
  TEST: services/gateway/test/vtid-05043-s3-migrations.test.ts ("opens exactly maxina and alkalma, asserted with GET DIAGNOSTICS")
  TEST: pglite-migration-check.mjs ("A: open_signup = {alkalma, maxina}")

AC-3: Migration B backfills every drifted member that exists (has an `app_users` row) into `user_tenants` with zero side effects, sets `welcome_chat_sent = true`, makes a row primary only for a user without one, leaves deleted-account rows alone, and aborts on >30 rows, a closed tenant, or a real auth user without `app_users`.
  TEST: services/gateway/test/vtid-05043-s3-migrations.test.ts (Migration B)
  TEST: pglite-migration-check.mjs ("B: inserted 15 drifted memberships", "B: 0 side effects", "B aborts ...")

AC-4: Migration B resets every non-exafy `active_tenant_id` claim without a membership to the user's primary tenant (or removes the key), aborts above 50, and post-checks drift = 0 and claims = 0 inside the transaction.
  TEST: services/gateway/test/vtid-05043-s3-migrations.test.ts ("asserts the claim set", "post-checks drift = 0 and claims = 0")
  TEST: pglite-migration-check.mjs ("B: bad claim reset ...", "B: exafy_admin claim untouched", "B aborts above 50 bad claims")

AC-5: `switch_to_tenant_by_slug` uses `tenant_id`; a member or exafy_admin only switches; a non-member joins only an `open_signup` tenant (memberships + role_preferences + user_tenants, primary only when none exists, ON CONFLICT DO NOTHING); any other tenant raises `TENANT_NOT_JOINABLE` (42501); no `auth.uid()` raises 42501.
  TEST: services/gateway/test/vtid-05043-s3-migrations.test.ts (Migration C)
  TEST: pglite-migration-check.mjs ("C: non-member -> closed tenant raises 42501", "C: new user joins alkalma", "C: second membership is NOT primary", "C: exafy_admin switches ...")

AC-6: Steady state is write-free: a repeat call by an existing member updates 0 `auth.users` rows and adds 0 audit rows; an audit row is written only on a real change.
  TEST: pglite-migration-check.mjs ("C: repeat call -> 0 rows updated in auth.users", "C: repeat call -> 0 audit rows added")
  TEST: services/gateway/test/vtid-05043-s3-migrations.test.ts ("is write-free in steady state")

AC-7: EXECUTE on `switch_to_tenant_by_slug` is revoked from PUBLIC and anon and granted to authenticated.
  TEST: services/gateway/test/vtid-05043-s3-migrations.test.ts ("revokes PUBLIC and anon, grants authenticated")
  TEST: pglite-migration-check.mjs ("C: anon cannot execute", "C: authenticated can execute")
  CURL: post-apply-checks.sql query 8 (has_function_privilege anon = false) after apply

AC-8: The suppression setting is only ever transaction-local: no migration sets `vitana.*` with ALTER DATABASE / ALTER ROLE, every `set_config` in A/B/C passes `true`, and the setting is gone after COMMIT.
  TEST: services/gateway/test/vtid-05043-s3-migrations.test.ts ("no migration in the repo sets vitana.* via ALTER DATABASE / ALTER ROLE")
  TEST: pglite-migration-check.mjs ("B: suppression setting gone after COMMIT")

AC-9: Each migration has a rollback: guard rollback restores the original WHEN and drops the helper; switch rollback restores the live body captured before apply and its grants; backfill rollback deletes exactly the rows B inserted and restores the snapshots.
  TEST: services/gateway/test/vtid-05043-s3-migrations.test.ts (rollbacks)
  TEST: pglite-migration-check.mjs ("rollback C: live body restored verbatim", "rollback B: exactly the 15 backfilled rows deleted", "rollback A: original WHEN restored")

AC-10: After apply, read-only checks show: 4 guarded enabled triggers, open_signup = {alkalma, maxina}, drift = 0, bad claims = 0, anon cannot execute the RPC.
  CURL: docs/validation/VTID-05043/post-apply-checks.sql (run read-only after RUN-MIGRATION; results recorded in post-apply-results.md)

AC-11: The migrations sort after the VTID-05041 SECURITY DEFINER lockdown (20261010164100) and comply with its rule: the only SECURITY DEFINER function created (Migration C) revokes PUBLIC and anon in the same file; Migration A creates no definer function and recreates no trigger function.
  TEST: services/gateway/test/vtid-05043-s3-migrations.test.ts ("SECURITY DEFINER lockdown rule (VTID-05041)")
