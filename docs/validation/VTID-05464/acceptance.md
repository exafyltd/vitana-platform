# Acceptance — VTID-05464 (mt-identity-r2 / lane `access-token-hook-shadow`)

Change types: Database.

Plan `.kiro/specs/mt-identity-r2/plan.md` "Fix" 3, tasks S1–S3, requirements R3.1–R3.4. Sparring record:
`plan-sparring.md` (CONVERGED, policy `converged-auto-v1`, plan hash `9e7bf2ae…cc1`).

VALIDATION_PROFILE: database (migration files only; nothing deploys).

The hook stays SHADOW. It computes `tenant_id_shadow` and logs disagreements; it never adds, changes or removes a
`tenant_id` or any other existing claim. It is not configured in Supabase Auth: enabling it (GO-LIVE) is the
separate owner-applied lane (D14, R3.4). Nothing is applied from the PR.

## Files
- `supabase/migrations/20261102032000_vtid_05464_access_token_hook_shadow.sql` — S1, `public.custom_access_token_hook_shadow(event jsonb)`.
- `supabase/migrations/20261102032100_vtid_05464_tenant_claim_mismatch_log.sql` — S2, `public.tenant_claim_mismatch_log`.
- `supabase/migrations/20261102032000_vtid_05464_access_token_hook_shadow_rollback.sql` — S3, drops both.
- `supabase/tests/mt_identity_hook_fixture.sql` — roles + live `user_tenants` shape for a throwaway cluster.
- `supabase/tests/mt_identity_hook_shadow.test.sql` — pgTAP plan, 36 assertions.
- `docs/validation/VTID-05464/post-check.sql` — read-only pre/post checks for the RUN-MIGRATION window.

## Acceptance criteria (tasks.md group `access-token-hook-shadow`)

pgTAP was not run on this host (no PostgreSQL here). The pgTAP tests below are unproven until they run on a throwaway
local cluster; see `outputs/pgtap-not-run.md`. Each criterion has an `AC-<n>:` line and a `TEST:` line that names the
proving test or file.

AC-1: "pgTAP: the hook returns the original claims on a forced error" (S1 fail-open; R3.2).
`EXCEPTION WHEN OTHERS THEN RETURN event` around the whole body; the log write has its own inner handler.
TEST: `supabase/tests/mt_identity_hook_shadow.test.sql`: "forced error (user_tenants missing)", "(user_id not a uuid)",
"(claims not an object)", "(active_tenant_id not a uuid)", "NULL event", "log unavailable: the hook still returns
the shadow claim".

AC-2: "never emits a top-level `tenant_id`" (S1 "emitting `tenant_id_shadow` ONLY"; R3.1).
The only `jsonb_set` path is `{claims,tenant_id_shadow}`; the migration's self-check refuses a body containing
`{claims,tenant_id}`.
TEST: `supabase/tests/mt_identity_hook_shadow.test.sql`: "no top-level tenant_id claim is emitted", "disagreement: still
no top-level tenant_id", "tenant_id_shadow is the only change to the event".

AC-3: S1 reads the active `user_tenants` membership; `app_metadata.active_tenant_id` is a preference only.
One query on `public.user_tenants` by `user_id` (index `idx_user_tenants_user`,
`20251231000000_vtid_01101_phase_a_bootstrap.sql:103`), ordered: preferred tenant if it is a membership, then
`is_primary desc, created_at, tenant_id` (the `resolvePrimaryTenant()` order).
TEST: `supabase/tests/mt_identity_hook_shadow.test.sql`: "no preference: shadow is the primary membership", "preference
for a tenant the user is a member of is honoured", "preference for a non-member tenant is ignored", "no is_primary row:
shadow is the oldest membership", "no membership: event unchanged".

AC-4: S1/R3.2 single indexed lookup, short statement timeout.
`SET lock_timeout = '100ms'`, `SET statement_timeout = '500ms'`, `SET search_path = ''` on the function.
TEST: `supabase/tests/mt_identity_hook_shadow.test.sql`: "hook pins search_path, lock_timeout and statement_timeout";
the migration's own self-check.
Note: Postgres arms `statement_timeout` when a top-level statement starts, so inside the hook call the effective
bounds are `lock_timeout` (read when a lock wait begins; its 55P03 is caught → fail open), the single index probe and
Supabase Auth's own 2 s limit for Postgres hooks. Recorded under "Decisions taken".

AC-5: "The mismatch log fills on a deliberate disagreement" (S2; R3.3).
Decisions `preference_not_member`, `no_membership`, `primary_missing`; one row per
(user, decision, claimed, shadow) via `UNIQUE NULLS NOT DISTINCT`, repeats bump `seen_count`.
TEST: `supabase/tests/mt_identity_hook_shadow.test.sql`: "mismatch log: one preference_not_member row, repeat counted
(seen_count 2)", "mismatch log: primary_missing row", "mismatch log: no_membership row with the claimed tenant", "agreeing
calls write no mismatch row", "mismatch log refuses an unknown decision".

AC-6: "`authenticated` cannot read the log; `service_role` can" (S2 service-role-only).
`REVOKE ALL … FROM PUBLIC`, `FROM anon, authenticated`; `GRANT ALL … TO service_role`; identity sequence the same;
RLS enabled, no policy; migration self-check.
TEST: `supabase/tests/mt_identity_hook_shadow.test.sql`: "authenticated cannot read the mismatch log", "authenticated
cannot write the mismatch log", "anon cannot read the mismatch log", "service_role reads the mismatch log (3 rows)",
"RLS is enabled on the mismatch log", "the mismatch log carries no policy".

AC-7: hook grants per Supabase's auth-hook guide.
`GRANT USAGE ON SCHEMA public` and `GRANT EXECUTE` to `supabase_auth_admin` (guarded: skipped with a NOTICE where the
role does not exist, e.g. Aurora); `REVOKE ALL` from PUBLIC, anon, authenticated, service_role.
TEST: `supabase/tests/mt_identity_hook_shadow.test.sql`: "anon cannot execute the hook", "authenticated cannot execute
the hook", "service_role cannot execute the hook", "supabase_auth_admin can execute the hook", "supabase_auth_admin has
USAGE on schema public", "supabase_auth_admin (the Auth server) gets the shadow claim", "authenticated cannot call the hook".

AC-8: "The migrations apply and roll back clean on the local stack".
Both forward files are idempotent (CREATE OR REPLACE / IF NOT EXISTS / repeatable grants), wrapped in one
`BEGIN; … COMMIT;`, and end with a self-check that RAISEs. The rollback drops both and self-checks; a second run is a
no-op.
TEST: harness order in `docs/validation/VTID-05464/commands.log` (apply each forward file twice, replay the rollback in
sort order = no-op, pgTAP, rollback, rollback again, re-apply). **Not run on this host** (no PostgreSQL, no working
Docker). Static stand-ins in `docs/validation/VTID-05464/outputs/static-checks.txt`: the SQL parses with libpg-query
18.2.2 (PostgreSQL grammar, PL/pgSQL bodies) and passes PR-GATE `lintMigration`.

AC-9: "Nothing is applied from the PR" (S3 "No auth-config change here").
No workflow, Auth config or gateway file is in the diff. Apply: owner-approved `RUN-MIGRATION.yml`, one dispatch per
file in queue order (032000, then 032100), `post-check.sql` before and after.
TEST: `git diff --name-only origin/main...HEAD` lists only `supabase/` and `docs/validation/VTID-05464/` paths, and
`supabase/config.toml` enables no hook (`outputs/static-checks.txt`, checks 6 and 7).

AC-10: PR title. `VTID-05464 (mt-identity-r2/access-token-hook-shadow): …` (set by the caller when it opens the PR).
TEST: `scripts/ci/validate-pr-locally.cjs`, Merge Deploy Gate (exit 90 when the title lacks the VTID), run with the PR
title and body.

## Rollback
`20261102032000_vtid_05464_access_token_hook_shadow_rollback.sql` via RUN-MIGRATION after owner approval. Precondition:
the hook is not configured in Auth. It acts only when `tenant_claim_mismatch_log` exists (both forward files applied),
so an in-order replay of `supabase/migrations/` (where it sorts between the two forward files) is a no-op. If only
032000 was applied, roll back with `DROP FUNCTION IF EXISTS public.custom_access_token_hook_shadow(jsonb);`.

## MIGRATION-QUEUE rows (for `docs/multitenancy/MIGRATION-QUEUE.md`, outside this lane's paths)
| # | File | Lane / VTID | Depends on | Rollback | Window | Status |
|---|---|---|---|---|---|---|
| next | `20261102032000_vtid_05464_access_token_hook_shadow.sql` | mt-identity-r2 access-token-hook-shadow / VTID-05464 (S1) | live `user_tenants` + `idx_user_tenants_user` | `20261102032000_vtid_05464_access_token_hook_shadow_rollback.sql` | any; `post-check.sql` pre section first | pending |
| next+1 | `20261102032100_vtid_05464_tenant_claim_mismatch_log.sql` | mt-identity-r2 access-token-hook-shadow / VTID-05464 (S2) | previous row | same rollback file | right after; `post-check.sql` post section after | pending |

## Decisions taken
- SECURITY DEFINER (owner = migration role, `search_path = ''`, every object schema-qualified) instead of Supabase's
  invoker default. An invoker hook would need SELECT on `user_tenants` plus a new RLS policy for
  `supabase_auth_admin` there, and INSERT on the log for `supabase_auth_admin`. That widens the VTID-05147 membership
  lockdown and the service-role-only log. Only `supabase_auth_admin` can execute the function.
- `statement_timeout` is pinned as the plan asks, but `lock_timeout` is the bound that acts inside the call (see AC-4).
- `tenant_id_shadow` is a top-level claim, a string uuid, added only when a membership resolves; no membership leaves
  the event byte-identical.
- The log de-duplicates per (user, decision, claimed, shadow) so token refreshes cannot grow it without bound.
- The rollback's replay guard (acts only when the log table exists), because the plan puts the rollback in
  `supabase/migrations/` under the forward file's version.
- `staging-tests.json` has no `service` and an empty `tests` list with `not_verified_on_staging`: nothing deploys,
  and STAGING-VERIFY's nightly full run skips a manifest that is not for its service. The plan names no existing suite
  for this lane.
