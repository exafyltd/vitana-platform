# FU9 — Revoke EXECUTE on the VTID-05041 memory functions from the `migrate` role

change class: standard (contains a migration)
scope: one new migration `supabase/migrations/<ts>_vtid_<NNNNN>_memory_functions_revoke_migrate.sql`; one SQL test `scripts/ci/sql-tests/run-memory-functions-migrate-revoke-test.sh` + its workflow `.github/workflows/SQL-MEMORY-FUNCTIONS-MIGRATE-REVOKE.yml` (pattern: `SQL-MEMORY-SENSITIVITY.yml`); `docs/validation/<VTID>/` evidence (live-before ACLs). No gateway code, no deploy.

<!-- plan:begin -->

## Problem (evidence, read-only, 2026-10-12, project inmkhvwdcuyhnxkgfvsb)

1. **`migrate` still executes all four memory functions.** `has_function_privilege('migrate', …, 'EXECUTE')`
   = true for every one, each `SECURITY DEFINER`, owner `postgres`, ACL
   `{postgres=X/postgres, service_role=X/postgres, migrate=X/postgres}`:
   `write_fact(uuid,uuid,text,text,text,text,text,uuid,numeric,uuid)`,
   `get_current_facts(uuid,uuid,text,text[])`,
   `recall_at_time_range(uuid,timestamptz,timestamptz,text)`,
   `memory_facts_semantic_search(vector,integer,uuid,uuid,text,numeric)`.
   VTID-05041 (`20261010164100_vtid_05041_definer_functions_lockdown.sql`) revoked
   `PUBLIC, anon, authenticated` only, and its self-check tests only those roles plus
   `service_role`, so `migrate` was left as-is. These functions take `p_user_id` and never
   check `auth.uid()`: whoever holds the `migrate` password can read and overwrite any
   member's memory facts.
2. **What `migrate` is.** `pg_roles`: `rolcanlogin=true`, `rolreplication=true`,
   `rolbypassrls=true`, `rolsuper=false`, no `rolconfig`, no expiry, no live sessions.
   It is the **AWS DMS source role for the Supabase → Aurora migration**
   (`docs/AURORA-MIGRATION-STATUS-2026-09-10.md` §1 and the endpoint table: DMS endpoints
   `vitana-src-supabase-v3`, `vitana-supabase-source-autopilot`,
   `vitana-supabase-source-fullload` log in as `migrate`; `awsdms_heartbeat` shows it wrote
   heartbeats 2026-07-21 → 2026-08-20). `postgres` is a member of `migrate`
   (not the reverse). No workflow, script or service in the repo logs in as `migrate`
   (repo grep; every `PGUSER` in `.github/workflows` is `postgres` on a local service
   container). The password lives in the DMS endpoint configs.
3. **DMS does not need EXECUTE.** DMS full load reads tables (`SELECT`), CDC reads the
   replication slot (`rolreplication`), and it writes only its own `awsdms_*` tables. It
   never calls application RPCs. So revoking EXECUTE on these four functions cannot break
   the migration path.
4. **Wider exposure found while verifying (not in FU9's scope, see Owner decisions):**
   `migrate` holds EXECUTE on 405 of 835 public functions (292 of 516 SECURITY DEFINER),
   and table `SELECT` via a `postgres` default ACL (`migrate=r/postgres` for new public
   tables). Among DEFINER functions that are otherwise service-role-only, `migrate` can also
   execute: `decrypt_api_key(text)`, `encrypt_api_key(text)`, `fn_consume_credits(…)`,
   `credit_deposit(…)`, `credit_wallet_for_earning(…)`, `debit_wallet_for_spend(…)`,
   `increment_wallet_balance(…)`, `update_user_stripe_status(…)`,
   `dev_bootstrap_request_context(…)`, `dev_set_request_context(…)`,
   `health_compute_vitana_index_for_user(…)`, `scheduler_vitana_index_compute_daily(…)`.
   The pattern looks like a one-time `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO migrate`
   when DMS was set up (VTID-05043's `live-before.sql` shows the same `migrate=X` on
   `switch_to_tenant_by_slug`).
5. Also observed: an inactive `test_decoding` replication slot
   `6hxjwolrf5fa3dnd_00000005_…` (DMS-shaped name; `restart_lsn` NULL, so no WAL size
   reported). Not part of this fix; noted for the Aurora track.

## Fix

New migration, same shape as VTID-05041 (effect-checked, idempotent, single transaction):

```sql
BEGIN;
DO $revoke$
DECLARE r record;
BEGIN
  IF to_regrole('migrate') IS NULL THEN
    RAISE NOTICE '<VTID>: role migrate absent, nothing to revoke';
    RETURN;
  END IF;
  FOR r IN
    SELECT p.oid::regprocedure AS fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.proname IN ('write_fact','get_current_facts','recall_at_time_range','memory_facts_semantic_search')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM migrate', r.fn);
  END LOOP;
END
$revoke$;

DO $check$
DECLARE r record; n int := 0;
BEGIN
  -- Same existence check as VTID-05041 (20261010164100 L159-163): all four names present.
  IF (SELECT count(DISTINCT p.proname)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE p.proname IN ('write_fact','get_current_facts','recall_at_time_range','memory_facts_semantic_search')) <> 4 THEN
    RAISE EXCEPTION '<VTID>: expected all four memory functions to exist';
  END IF;
  FOR r IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.proname IN ('write_fact','get_current_facts','recall_at_time_range','memory_facts_semantic_search')
  LOOP
    n := n + 1;
    IF to_regrole('migrate') IS NOT NULL AND has_function_privilege('migrate', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '<VTID>: % still executable by migrate', r.oid::regprocedure;
    END IF;
    IF has_function_privilege('authenticated', r.oid, 'EXECUTE') OR has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '<VTID>: % executable by members — VTID-05041 regressed', r.oid::regprocedure;
    END IF;
    IF NOT has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '<VTID>: service_role (gateway) must keep EXECUTE on %', r.oid::regprocedure;
    END IF;
  END LOOP;
  -- Exact overload count, captured live 2026-10-12: one overload per name (4 total).
  -- A new overload must fail this migration so it is reviewed, not silently revoked.
  IF n <> 4 THEN RAISE EXCEPTION '<VTID>: expected exactly 4 overloads, found %', n; END IF;
END
$check$;
COMMIT;
```

- **Why this is worth doing although `migrate` can already SELECT public tables directly:**
  `write_fact` *writes*. `migrate` has only `r` (SELECT) on public tables, so revoking
  EXECUTE removes its ability to overwrite member facts through the definer path. The
  table SELECT / default-ACL read exposure is wider and is tracked as the separate follow-up
  **FU9b — `migrate` table SELECT and `postgres` default ACL in `public`** (Out of scope);
  the 12 other service-only DEFINER functions are **FU9a** (Owner decision 1).
- `has_function_privilege` covers both a direct grant and one inherited through role
  membership, so the check proves the end state, not just that the REVOKE ran.
  `migrate` is not a member of any role that holds EXECUTE (only `postgres` is a member *of*
  `migrate`), so the direct REVOKE is sufficient; the check would RAISE otherwise.
- Bodies untouched; `CREATE OR REPLACE` later keeps the ACL. Absent role (fresh DB, Aurora)
  → NOTICE, not failure.
- Header records the caller inventory (only the gateway on `service_role` and
  `scripts/backfill-memory-facts.mjs`, per VTID-05041's own inventory) and why DMS does not
  need EXECUTE.

## Tests

1. `scripts/ci/sql-tests/run-memory-functions-migrate-revoke-test.sh` on a `postgres:16`
   service container: create roles `anon`, `authenticated`, `service_role`, `migrate`
   (login, replication) and `GRANT migrate TO postgres` to mirror the live role graph
   (`postgres` is a member of `migrate`); create stub SECURITY DEFINER functions with the four live
   signatures; reproduce the live ACL (revoke PUBLIC/anon/authenticated, grant
   service_role + migrate); apply the migration with `psql -v ON_ERROR_STOP=1`; assert
   `has_function_privilege('migrate', …)` false and `service_role` true for all four.
   Negative cases (each must make the migration fail and roll back): an extra
   `GRANT EXECUTE … TO authenticated` before applying; `service_role` revoked before
   applying; one function dropped. Idempotency: apply twice, second run succeeds. Absent
   role: drop `migrate`, apply → succeeds with the NOTICE. Overload guard: add a fifth
   `write_fact` overload → migration fails.
   The workflow `SQL-MEMORY-FUNCTIONS-MIGRATE-REVOKE.yml` triggers on `pull_request` /
   `push` with `paths:` covering the new migration file, the test script
   `scripts/ci/sql-tests/run-memory-functions-migrate-revoke-test.sh` and the workflow
   itself, plus `workflow_dispatch`.
2. Gateway Jest suites that touch memory stay green (no code change; run
   `npm run test:support` and the memory-facts tests as a smoke).
3. Post-apply read-only check on production (part of rollout, not a test suite):
   `SELECT p.oid::regprocedure, has_function_privilege('migrate', p.oid, 'EXECUTE'),
   has_function_privilege('service_role', p.oid, 'EXECUTE') … WHERE proname IN (…)`.
4. No staging suite: the change deploys nothing. Applying the migration is a production
   DB write.

## Rollout

**Governance of the production write.** The only production write is the
`RUN-MIGRATION.yml` dispatch in step 4. It is covered by the owner's Gate 1 "yes" for this
plan, and the Gate 1 message names that dispatch explicitly (workflow, migration path,
target project `inmkhvwdcuyhnxkgfvsb`). No other production write is authorised by this plan.
The change deploys no service, so there is no STAGING-VERIFY; the closing report to the
owner (before-state, run link, post-check output) is the Gate 2 equivalent. Same model as
the converged FU8 plan.

1. PR (migration + SQL test + workflow), CI green, merge.
2. Immediately before dispatch, a read-only before-state check: all 4 functions exist
   (exactly 4 overloads) and `has_function_privilege('migrate', …)` is true for each. Save the
   output to `docs/validation/<VTID>/live-before.sql`. If it does not match (e.g. already
   revoked, or a function missing/changed), do **not** dispatch; report to the owner instead.
3. Same check confirms `service_role` holds EXECUTE and `anon`/`authenticated` do not, so
   the migration's own self-check is expected to pass.
4. Dispatch `RUN-MIGRATION.yml` with the migration path (the production write covered by
   Gate 1). The in-migration check makes a wrong end state roll back and turn the run red.
5. Read-only post-check (Tests §3), output saved to `docs/validation/<VTID>/`. **The work is
   done when this post-check passes**: `migrate` false, `service_role` true, `anon`/
   `authenticated` false for all four.
6. Closing report to the owner (Gate 2 equivalent): before-state, run link, post-check.
5. Rollback (only if something unexpected needs it):
   `GRANT EXECUTE ON FUNCTION <each of the four> TO migrate;`, kept in the evidence folder.

## Risks

- A DMS task that called these functions would break. Nothing in DMS's design or the repo
  does; the live DMS CDC is currently not running (endpoints failing since 2026-08-20 per
  the Aurora status doc). Low.
- A future `DROP FUNCTION` + `CREATE` of any of the four resets ACLs to the `postgres`
  public default ACL (`anon, authenticated, service_role`) — that reopens VTID-05041's hole,
  not `migrate`'s. Out of scope here; the 05041 self-check pattern catches it only if re-run.
- `REVOKE ALL … FROM migrate` touches only `migrate`'s own grants; other roles' ACL entries
  are unchanged (asserted by the checks).

## Out of scope

- The other 401 public functions (incl. the 12 service-only DEFINER functions listed in
  Problem §4 → FU9a) and `migrate`'s table SELECT / default ACL (→ FU9b).
- Disabling `migrate`'s login or rotating its password; the stale DMS replication slot;
  anything on the Aurora side.
- Changing VTID-05041's file (already applied; history stays).

## Owner decisions

0. **Gate 1 covers the production write:** approving this plan approves exactly one
   `RUN-MIGRATION.yml` dispatch of this migration against `inmkhvwdcuyhnxkgfvsb`, gated on
   the read-only before-state check (Rollout step 2); completion = passing read-only
   post-check; the closing report is the Gate 2 equivalent.
1. **Scope:** the four memory functions only (FU9 as filed — recommended for this change)
   vs also the 12 otherwise service-only SECURITY DEFINER functions in Problem §4
   (`decrypt_api_key`, wallet/credit functions, `dev_set_request_context`, …) in the same
   migration with the same check. Recommended: do the 12 as an immediate separate
   follow-up with its own caller inventory, since `decrypt_api_key`/wallet RPCs are the
   larger exposure (FU9a). Table SELECT / default ACL: FU9b.
2. **The role itself:** keep `migrate` login-enabled for the Aurora cutover, or set
   `NOLOGIN` until DMS is resumed (it has not connected since 2026-08-20). Not part of this
   change; needs the Aurora track owner.

<!-- plan:end -->

## Planner responses — round 1

- **F1 [minor] — ACCEPTED.** The self-check now opens with VTID-05041's own
  `count(DISTINCT p.proname) <> 4` check. The loop stays, and its count is tightened to an
  exact `n <> 4`: live has one overload per name, 4 in total, per the 2026-10-12 catalog
  query. A new overload therefore fails the migration and gets reviewed instead of being
  revoked silently. The test adds a fifth-overload case that must fail.
- **F2 — withdrawn by partner.** No change.
- **F3 [major] — ACCEPTED.** Fix section now says: `write_fact` writes, and `migrate` has
  only SELECT on public tables, so revoking EXECUTE removes its ability to overwrite member
  facts through the definer path. The wider table SELECT / default-ACL read exposure is
  named and tracked as follow-up **FU9b**. The 12 other service-only DEFINER functions are
  **FU9a**. Out of scope and Owner decisions refer to both by name.
- **F4 [minor] — ACCEPTED.** Test setup adds `GRANT migrate TO postgres` to mirror the live
  role graph (`postgres` is a member of `migrate`).
- **F5 [minor] — ACCEPTED.** The workflow's `paths:` trigger covers the new migration file,
  `scripts/ci/sql-tests/run-memory-functions-migrate-revoke-test.sh` and the workflow
  itself. It also keeps `workflow_dispatch`.
- **F6 [blocker] — ACCEPTED.** The Rollout section now has a "Governance of the production
  write" paragraph and Owner decision 0. The `RUN-MIGRATION.yml` dispatch is the only
  production write. The owner's Gate 1 "yes" covers it, and the Gate 1 message names it
  explicitly (workflow, file, project).
  - The dispatch runs only after the read-only before-state check confirms that exactly 4
    functions exist, that `migrate` holds EXECUTE on each, and that `service_role` holds
    EXECUTE while `anon`/`authenticated` do not. If any of this fails, there is no dispatch
    and the session reports to the owner.
  - The work is done when the read-only post-check passes.
  - The closing report to the owner is the Gate 2 equivalent. This is the same model as the
    converged FU8 plan.

## Owner approval (Gate 1)
Approved by owner in Claude Code session https://claude.ai/code/session_01TMPMNGNEtPxKwmVqyfdx46 on 2026-10-12 ("Yes"), including the recommended option for every owner decision and the production steps named in the plan. Verdict: CONVERGED (2 rounds).

## Record
- `<VTID>` / `<NNNNN>` in the plan text = VTID-05125; migration
  `supabase/migrations/20261013090000_vtid_05125_memory_functions_revoke_migrate.sql`.
- Final plan hash (as recorded on the sparring record): `9263080a07a90d1296609681c7d9883fa773b17876fdaba85159d5e5ee1a2f72`.
- Sparring record: `d50d7db8-37b4-4eba-af37-e589db92ec14`. Partner: plan-sparring-partner, 2 rounds. Verdict: **CONVERGED**.

Owner approval (Gate 1): "Yes" — 2026-10-12, Claude Code session; plan hash 9263080a07a90d1296609681c7d9883fa773b17876fdaba85159d5e5ee1a2f72; sparring record d50d7db8-37b4-4eba-af37-e589db92ec14.
