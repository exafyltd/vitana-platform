# VTID-05023 R3S security scan (repo only)

Lane: R3S. Branch: `cutover/vtid-05023-R3S-security-scan`, from `origin/main` at `c7e17d64d9`.
Scope: static reading of `supabase/migrations`, the tests, and `docs/validation`. Read-only. No database, AWS, rehearsal, or production access was used. The only file changed is this report. No migration was edited.

Production state is not verified here. Where a finding depends on what is deployed, the owner runs the read-only check named in "Production checks for the owner".

## Method and limits

- Grants and revokes: every `GRANT` and `REVOKE ... ON FUNCTION` statement in the migrations was parsed in file-name order. A `DROP FUNCTION` resets that function's grants. Statements built with `format()` inside `DO` loops cannot be tied to one function. Fourteen migration files contain such loops. A function named by one of those loops after its grant is marked in Appendix A. It is not treated as revoked.
- Function exposure: a function is "open" when no migration revokes EXECUTE from PUBLIC or anon for its name. The phase_c loop (`20260608130000_phase_c_rpc_anon_lockdown.sql`, lines 20-52) revokes from PUBLIC and anon for pre-existing SECURITY DEFINER functions that return something other than `trigger`, `void` or `boolean`, and that no policy references. I counted 210 functions as covered by that loop. That count is an inference from the loop's SQL, not a checked result.
- Tables: a table has RLS when a static `ENABLE ROW LEVEL SECURITY` exists, or when a `DO` loop with a literal name list enables it. I read each such loop. Personal-data candidates come from a name keyword list (user, profile, message, credit, wallet, member, account, memory, health, location and similar). The list is a heuristic, not a data classification.
- Secrets: the scan used the seven patterns in the task. Each match was classified by shape (length, character classes, whether it decodes as a JWT and what its `role` claim is). No matched value appears in this report.
- Not run: no build, no test suite, no SQL. Nothing was executed against a database.

## Findings

Severity: High means a path to personal data or to privileged writes, pending a production check. Medium means a real gap with narrower reach. Low and Info are hygiene or documentation items.

| # | Finding | File | Line | Severity | Owner action needed |
|---|---|---|---|---|---|
| 1 | `fn_consume_credits` is closed to members in the repo. 04981 revokes EXECUTE from members, and 04988 (the later file) revokes it again. Only service_role keeps EXECUTE. | `20261008170000_vtid_04981_consume_credits_lockdown.sql`; `20261008190000_vtid_04988_earned_vtna_rewards_only.sql` | 04981: 20-21. 04988: 94-95 (`CREATE OR REPLACE` at 28) | Info (closed in repo) | Confirm in production with PC-2. See section "fn_consume_credits". |
| 2 | The memory functions `write_fact`, `get_current_facts`, `recall_at_time_range` and `memory_facts_semantic_search`, and `get_user_profile_by_identifier`, stay open to members until VTID-05041 is applied. The 2026-10-10 baseline in the repo showed authenticated and/or anon EXECUTE, and an `email` return column, before apply. | `20261010164100_vtid_05041_definer_functions_lockdown.sql` | 38-50 (memory loop), 134 (anon and authenticated grant) | High until applied | Confirm 05041 is applied with PC-3. `DATABASE_SCHEMA.md` (line 1755) says it was committed and not applied. |
| 3 | `update_user_stripe_status` and `update_user_stripe_account` are SECURITY DEFINER. No migration revokes them from PUBLIC or anon. The phase_c loop skips VOID-returning functions. The status function writes Stripe flags on `app_users` for whatever account id it receives, with no caller check. | `20260209_vtid_01231_stripe_connect.sql` | 26 (account), 39 (status), DEFINER at 51 | High (pending PC-1) | Run PC-1. If anon or authenticated can execute these, add a revoke in a new migration. |
| 4 | The wallet RPCs `process_wallet_transfer`, `process_wallet_exchange`, `process_wallet_exchange_and_send` and `get_user_balance` are SECURITY DEFINER with no revoke from PUBLIC or anon. Their ownership check is `auth.uid() IS NOT NULL AND auth.uid() <> p_user_id`. A call with no JWT (anon) has `auth.uid()` NULL and passes. The 0717 migration says it allows NULL on purpose for service_role calls. | `20260720190000_fix_wallet_rpc_atomicity_and_transaction_logging.sql`; `20260717120000_harden_wallet_rpc_ownership_and_rate_lookup.sql` | 20260720190000: functions 106, 186, 248; checks 125, 201, 270. 20260717120000: `get_user_balance` 336, check 42 | High (pending PC-1) | Run PC-1. If anon can execute these, revoke from PUBLIC and anon, and keep the service_role path working. |
| 5 | `dev_agent_memory` has no RLS and no grant change. `recall_dev_memory` and `recall_dev_memory_by_files` are SECURITY DEFINER with no revoke, so they read this table for any caller that can reach them. | `20260914182357_vtid_03889_dev_agent_memory.sql`; `20260923190000_vtid_04407_dev_agent_memory_handoff.sql`; `20260921120000_bootstrap_dev_agent_memory_file_scope.sql` | table 28; `recall_dev_memory` 109 (latest definition at 97 in 04407); `recall_dev_memory_by_files` 101 | High (pending PC-3, PC-4) | Enable RLS with no member policy. Revoke member EXECUTE on both recall functions. |
| 6 | `oasis_events` (telemetry) has no RLS statement in any migration and gets SELECT for authenticated. If production matches the migrations, every signed-in member can read all rows. | `20251209000000_add_task_stage.sql` | table 10; grant 107 | High (pending PC-3, PC-4) | Confirm RLS with PC-3. If it is off, enable RLS with a tenant scope. Check which columns hold user ids. |
| 7 | `contextual_opportunities` has the policy `Service role full access on contextual_opportunities` with `USING (true) WITH CHECK (true)` and no TO clause. It applies to PUBLIC, so anon and authenticated can read and change every member's opportunity rows. Permissive policies combine with OR, so the member-owned policy at line 75 does not restrict this. | `20260704200000_vtid_01142_contextual_opportunities_table.sql` | 80 (RLS on at 70) | High | Re-target this policy to `service_role` in a new migration. Confirm with PC-5. |
| 8 | `user_consents_tenant_isolation` filters on `tenant_id` only, not `user_id`, and applies to every role. Any member of a tenant can read or change other members' consent rows. | `20260317000000_openclaw_bridge_tables.sql` | 54 (RLS on at 52) | High | Add `user_id = auth.uid()` to the member path in a new migration. |
| 9 | `admin_settings` (commission rate and other settings) has no RLS statement and no revoke. The repo comments say Supabase default privileges grant public tables to anon and authenticated, so table grants are probably open. | `20260715120000_vtid_02950_recommendation_commissions.sql` | 32 | High (pending PC-4) | Confirm with PC-4. If open, enable RLS and revoke member grants. |
| 10 | `notification_categories` has `service_role_full_access_categories` with `USING (true) WITH CHECK (true)` and no TO clause. Any role can write category rows. This is configuration, not personal data. | `20260416000000_notification_categories.sql` | 63 (RLS on at 60) | Medium | Add `TO service_role` in a new migration. Confirm with PC-5. |
| 11 | `autopilot_logs_tenant_isolation` is a tenant-only policy for all roles. It has the same shape as finding 8, on system logs. | `20260317000000_openclaw_bridge_tables.sql` | 25 | Medium | Decide whether members should see tenant autopilot logs. If not, scope it to service_role. |
| 12 | Live-room access functions are SECURITY DEFINER with no revoke: `live_room_check_access` and `live_room_update_metadata` (latest definitions), and `live_room_revoke_access`. | `20261105170000_live_room_cohost_authz.sql`; `20260209_vtid_01228_daily_co_live_rooms.sql` | 587, 641; 191 | Medium (pending PC-1) | Run PC-1. Read the bodies for caller checks. Revoke member EXECUTE if the bodies do not check the caller. |
| 13 | `fn_reap_stale_live_streams` is SECURITY DEFINER, writes live-stream state, and has no revoke. | `20260630120000_BOOTSTRAP_reap_stale_live_streams.sql` | 53 | Medium (pending PC-1) | Run PC-1. Revoke member EXECUTE if it is open. |
| 14 | `acquire_autopilot_run_lock` and `release_autopilot_run_lock` are SECURITY DEFINER with no revoke. A caller who can run them can hold or release the autopilot run lock. | `20260116000000_vtid_01179_autopilot_event_loop.sql` | 275, 310 | Medium (pending PC-1) | Run PC-1. Revoke member EXECUTE if it is open. |
| 15 | SECURITY DEFINER boolean and helper functions with no revoke: `check_memory_access_grant`, `is_user_blocked`, `is_user_dampened`, `memory_is_entity_locked`, `memory_is_entity_deleted`, `vtid_spec_exists`, `validate_role_assignment`. They return per-user state. | `20251231000001_vtid_01085_memory_retrieve_router.sql` (203); `20251231000001_vtid_01094_match_feedback_loop.sql` (819, 858); `20251231100000_vtid_01099_memory_governance_v1.sql` (919, 950); `20260119000000_vtid_01190_persistent_vtid_specs.sql` (364); `20260913000002_vtid_03832_role_functions.sql` (99) | as listed | Low | Review whether one member can query another member's state through these. |
| 16 | 40 SECURITY INVOKER functions have no revoke from PUBLIC or anon. They run with the caller's RLS, so their exposure is limited by their tables. Names are in Appendix C. | multiple | Appendix C | Low | Review in one batch with PC-1. |
| 17 | Systemic: Postgres grants EXECUTE to PUBLIC on each new function. The migrations revoke explicitly for some functions only. Of the functions that the phase_c loop covers, I count 210 as covered by inference. | `20260608130000_phase_c_rpc_anon_lockdown.sql` | 20-52 | Medium (systemic) | Confirm with PC-1 that anon cannot execute the SECURITY DEFINER functions named above. |
| 18 | The VTID-05466 rollback file sits in `supabase/migrations`. Its header says to run it only through RUN-MIGRATION.yml. Its body deletes `user_tenants` rows (membership data) and drops legacy tables. A bulk apply of the folder would run it. | `20261102031000_vtid_05466_membership_unification_rollback.sql` | 1-10 (header), 57 (DELETE on `user_tenants`) | Medium | Confirm the apply tooling skips it, or move it out of `supabase/migrations` (owner decision). Run PC-10 to see whether 05466 is applied. |
| 19 | Migrations write to Aurora-only tables: `health_codes`, `health_store_maintenance_runs`, the store tables, and `health_sources`. Each file has a placement guard that refuses to run where both `auth.users` and `storage.objects` exist. | `20261014100100_vtid_05158_health_store.sql`; `20261014100200_vtid_05161_health_sources.sql` | 05158: guard 47-56, seed 74, writes 413-814. 05161: guard 37-40, inserts 142, 175 | Info | Run PC-8 to confirm the nine Aurora-only tables are absent in production. |
| 20 | `e2e/verify-onboarding.ts` hard-codes the production Supabase URL and an anon-role JWT. It signs in the test account `e2e-test@vitana.dev` and runs a profile-save flow against the production web app. CLAUDE.md rule 31 forbids writing as the test account whose UUID starts `a27552a3`. | `e2e/verify-onboarding.ts` | 14 (URL), 15 (key), 22-24 (sign-in) | Medium | Run PC-7 to see whether that email is the rule-31 account. Move the URL and key to env. Confirm the flow does not write to production. |
| 21 | `e2e/verify-onboarding-final.ts`, `-local.ts` and `-ui.ts` use the rule-31 UUID as a mock user id (`MOCK_USER_ID`). They do not write. | the three files | 9; 16; 13 | Info | None, unless PC-7 shows the account is live. |
| 22 | `e2e/fixtures/test-users.ts` falls back to a hard-coded anon-role JWT when the env var is unset. | `e2e/fixtures/test-users.ts` | 20 | Low | Remove the literal fallback. The key is an anon key, so it is public by design. |
| 23 | `services/gateway/test/vtid-04019-no-token-prefixes-in-docs.test.ts` contains an AWS-access-key-shaped literal (uppercase, 20 characters). The file tests the token detector, so the literal is probably a fixture. This is not confirmed. | same | 75 | Low until confirmed | Run PC-9 to confirm the key is not live. If it is live, rotate it. |
| 24 | JWT-shaped strings in tests. `diary.test.ts` holds a mock with no role claim. The detector test holds a sample three-segment token. | `services/gateway/test/diary.test.ts`; `services/gateway/test/vtid-04019-no-token-prefixes-in-docs.test.ts` | 39; 77 | Info | None. |
| 25 | `password=` inside error-message strings in two gateway tests. The values are seven-character test strings. | `services/gateway/test/vtid-05031-webhook-verification.test.ts`; `services/gateway/test/routes/internal-gitlab-webhook.test.ts` | 227; 201 | Info | None. |
| 26 | Scanner false positives: `password` assigned from an env lookup or an expression in five staging specs and one command-hub fixture. | `e2e/staging/vtid-04842-commerce-ai-setup-on.staging.spec.ts`; `vtid-04873-narration-language.staging.spec.ts`; `vtid-05025-commerce-health-boundary.staging.spec.ts`; `vtid-05026-audiobook-voices.staging.spec.ts`; `vtid-05030-connection-tokens.staging.spec.ts`; `services/gateway/test/command-hub/fixtures/vtid-05073-app.base.js` | 15, 25, 21, 39, 21; 36935 | Info | None. |
| 27 | Rule numbering in CLAUDE.md: two different items are numbered 31 (the sidebar rule, and "NEVER write as this account"). Rules 43 and 44 are in CLAUDE.md, not in `.claude/rules`. | `CLAUDE.md` | 155, 407; 43 at 267; 44 at 272 | Low | Renumber one of the two 31s at the owner's convenience. |
| 28 | The orphan quarantine copies `bak_mt_data_cleanup_memory_facts`, `_memory_items`, `_chat_messages` and `_user_notifications` hold copies of personal rows. Their RLS is on with no policy, and member EXECUTE and table grants are revoked. Safe as configured. | `20261102040100_vtid_05571_orphan_quarantine_snapshots.sql` | 192-204 (names list, REVOKE at 202, RLS at 204) | Info | None. |
| 29 | Legacy backups in `legacy_archive` include profile and content-report copies. The schema has USAGE revoked from PUBLIC, anon and authenticated. | `20261005090000_vtid_04880_archive_nav_catalog.sql`; `20261102031000_vtid_05466_user_tenants_canonical.sql` | 202; 51 | Info | Run PC-6 to confirm the schema privileges hold in production. |
| 30 | No document defines a list of production-only objects. A search for "production-only" in `docs/` and `.claude/` finds only prose. The nearest documented list is `aurora_only_tables` in the migration-drift baseline (nine tables). Check 4 used that list. | `scripts/ci/migration-drift-baseline.json` | `aurora_only_tables` | Info | None. |
| 31 | The policies on `memory_facts`, `active_threads` and `thread_summaries` (role PUBLIC) compare the row's user and tenant with `app.user_id` and `app.tenant_id` session settings. The settings default to the zero UUID when unset. Low risk unless a client can set those settings. | `20260119000000_vtid_01192_infinite_memory_v2.sql` | 77, 131, 190 | Low | Confirm no client path sets `app.user_id` or `app.tenant_id` on a request. |
| 32 | The `events` table is not created in any migration. Its policy `events_authenticated_select` (`USING (true)`) lets any signed-in member read every row, if the table exists in production and holds user data. | `20260216000000_security_linter_fixes.sql` | 77 | Low | Confirm what `events` holds. |

### Member-granted functions

- 243 functions have a final explicit GRANT to authenticated, anon or PUBLIC. The final grants come from 292 GRANT entries. Seven functions are granted to anon: `discover_category_counts`, `get_public_vitana_index`, `get_user_profile_by_identifier`, `is_chat_group_member`, `is_partner_org_member`, `list_public_tenants` and `resolve_tenant`. No function has an explicit grant to PUBLIC.
- 231 of the 243 are SECURITY DEFINER. The full list is Appendix A.
- For these 243, no explicit REVOKE follows the last GRANT. That is how "final" is defined here. Thirty-five of them are also named by a later dynamic revoke loop, which PC-1 settles.
- 293 REVOKE events touch member roles, across 209 function names. 33 of those names hold a member grant again at the end, because a later GRANT follows the last REVOKE.

### fn_consume_credits

Function: `public.fn_consume_credits(uuid, uuid, integer, text, text, text)`. SECURITY DEFINER. Takes any `p_user_id`.

What each migration does, in order:

1. `20260526040000_VTID_03107_usage_helpers.sql`. Line 150 creates the function. Line 214 grants `EXECUTE ... TO service_role, authenticated`. That grant let any signed-in member call it for any user.
2. `20261008170000_vtid_04981_consume_credits_lockdown.sql`. Line 20 revokes ALL from `PUBLIC, anon, authenticated`. Line 21 grants EXECUTE to `service_role`. A self-check after the grant raises if members can still execute it.
3. `20261008180000_vtid_04982_rewards_shop.sql`. Lines 45-48 refuse to apply while anon or authenticated can execute the function. The file adds no grant.
4. `20261008190000_vtid_04988_earned_vtna_rewards_only.sql`. This is the latest migration that touches the function. It sorts after 04981. Line 28 replaces the body with `CREATE OR REPLACE` (same six-argument signature). Line 94 revokes ALL from `PUBLIC, anon, authenticated`. Line 95 grants EXECUTE to `service_role`. The revoke is repeated here, so the final state does not depend on 04981 having run first.
5. `20261010164100_vtid_05041_definer_functions_lockdown.sql`. Lines 142-171 are a self-check. It raises if members can execute `fn_consume_credits`. It does not grant or revoke.

Net repo state: after 04988, service_role is the only role with EXECUTE. No later migration grants it to members.

Production: `docs/validation/VTID-05041/outputs/live-baseline-2026-10-10.txt` (line 4) records authenticated, anon and PUBLIC as false and service_role as true for this signature. That is a read recorded in the repo on 2026-10-10. Re-check it with PC-2.

## Table RLS

- 527 `CREATE TABLE` matches. Nine are parser artifacts or temp tables, which leaves 518 persistent tables.
- Nine persistent tables have no RLS statement in any migration. Three are in `public`: `oasis_events`, `dev_agent_memory` and `admin_settings`. Six are in `legacy_archive`, whose schema USAGE is revoked from PUBLIC, anon and authenticated: `bak_vtid_05151_tenant_settings`, `bak_mt_data_cleanup_profiles`, `mt_profiles_tenant_backfill_log`, `mt_profiles_tenant_unresolved`, `bak_05491_content_reports` and `bak_05491_moderation_actions`.
- The 14 personal-data tables created by `20260427180000_vtid_02003_phase_5a_tier2_schema.sql` have RLS on and a `tenant_user_select` policy, applied through a DO loop (lines 459-492). They are covered.
- Policies that do not check the user, or that apply to PUBLIC: `contextual_opportunities` (finding 7) and `user_consents` (finding 8). `memory_facts`, `active_threads` and `thread_summaries` depend on session settings (finding 31).

Appendix B lists the 213 keyword candidates with their RLS and policy status.

## Production checks for the owner

Each check is read-only. Run it against the production database URL that you hold, in your own environment as `$PROD_DATABASE_URL`. The commands set `default_transaction_read_only=on`, so a stray write fails.

Prefix used for every command:

```
PGOPTIONS='-c default_transaction_read_only=on' psql "$PROD_DATABASE_URL" -X -A -F ' | ' -c "<SQL>"
```

**PC-1. Member-executable functions in `public`.** Covers findings 3, 4, 12, 13, 14, 15, 16, 17 and the 35 names flagged by dynamic loops.

```sql
SELECT p.oid::regprocedure AS fn, p.prosecdef AS security_definer,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND (has_function_privilege('anon', p.oid, 'EXECUTE')
    OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
ORDER BY p.prosecdef DESC, 1;
```

Anon inherits PUBLIC, so the `anon_x` column also covers a PUBLIC grant. Every row with `security_definer = t` and `anon_x = t` is a finding to escalate.

**PC-2. fn_consume_credits.** Covers finding 1. Expected: `f | f | t`.

```sql
SELECT has_function_privilege('anon', 'public.fn_consume_credits(uuid,uuid,integer,text,text,text)', 'EXECUTE') AS anon_x,
       has_function_privilege('authenticated', 'public.fn_consume_credits(uuid,uuid,integer,text,text,text)', 'EXECUTE') AS auth_x,
       has_function_privilege('service_role', 'public.fn_consume_credits(uuid,uuid,integer,text,text,text)', 'EXECUTE') AS service_x;
```

**PC-3. VTID-05041 applied, and RLS on the named tables.** Covers findings 2, 5 and 6.

```sql
SELECT p.oid::regprocedure AS fn,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('write_fact','get_current_facts','recall_at_time_range',
                    'memory_facts_semantic_search','get_user_profile_by_identifier');

SELECT pg_get_function_result('public.get_user_profile_by_identifier(text)'::regprocedure) AS returns;

SELECT c.relname, c.relrowsecurity AS rls_on, c.relforcerowsecurity AS rls_forced,
       (SELECT count(*) FROM pg_policies pol
         WHERE pol.schemaname = 'public' AND pol.tablename = c.relname) AS policies
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p')
  AND c.relname IN ('oasis_events','dev_agent_memory','admin_settings',
                    'contextual_opportunities','user_consents','notification_categories',
                    'autopilot_logs','memory_facts','active_threads','thread_summaries',
                    'bak_mt_data_cleanup_memory_facts','bak_mt_data_cleanup_memory_items',
                    'bak_mt_data_cleanup_chat_messages','bak_mt_data_cleanup_user_notifications',
                    'mt_orphan_quarantine')
ORDER BY 1;
```

Expected once 05041 is applied: `anon_x = f` and `auth_x = f` for the four memory functions. `get_user_profile_by_identifier` keeps anon and authenticated EXECUTE by design (05041 line 134), but its return type must not contain `email`. `oasis_events`, `dev_agent_memory` and `admin_settings` should show `rls_on = t` with at least one policy.

**PC-4. Table privileges for member roles.** Covers findings 5, 6, 9 and 11.

```sql
SELECT t.table_name,
       has_table_privilege('anon', format('public.%I', t.table_name), 'SELECT') AS anon_select,
       has_table_privilege('anon', format('public.%I', t.table_name), 'INSERT') AS anon_insert,
       has_table_privilege('authenticated', format('public.%I', t.table_name), 'SELECT') AS auth_select,
       has_table_privilege('authenticated', format('public.%I', t.table_name), 'INSERT') AS auth_insert
FROM (VALUES ('oasis_events'),('dev_agent_memory'),('admin_settings'),
             ('contextual_opportunities'),('user_consents'),('notification_categories'),
             ('autopilot_logs')) AS t(table_name);
```

**PC-5. Unconditional policies.** Covers findings 7, 8, 10 and 11.

```sql
SELECT tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND (qual IN ('true','(true)') OR with_check IN ('true','(true)') OR qual IS NULL)
ORDER BY tablename, policyname;
```

A row whose `roles` includes `public` or the member roles, with `qual` or `with_check` true, is a finding.

**PC-6. Schema privileges on legacy_archive.** Covers finding 29. Expected: `f | f`.

```sql
SELECT has_schema_privilege('anon', 'legacy_archive', 'USAGE') AS anon_usage,
       has_schema_privilege('authenticated', 'legacy_archive', 'USAGE') AS auth_usage;
```

**PC-7. Rule-31 account check.** Covers finding 20. Returns one boolean, and the email is not returned.

```sql
SELECT (id = 'a27552a3-0257-4305-8ed0-351a80fd3701'::uuid) AS is_rule31_test_account
FROM auth.users
WHERE email = 'e2e-test@vitana.dev';
```

`t` means the e2e flow writes as the rule-31 account. That is a rule violation and needs a decision.

**PC-8. Aurora-only tables absent from production.** Covers finding 19. Expected: no rows. The drift guard fails on any row.

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('health_codes','health_series_5m','health_series_1h','health_series_1d',
                     'health_observations','health_ingest_batches','health_ingest_quarantine',
                     'health_store_maintenance_runs','health_sources');
```

**PC-9. AWS key-shaped literal.** Covers finding 23. This is not a database check. Open `services/gateway/test/vtid-04019-no-token-prefixes-in-docs.test.ts` at line 75 yourself and copy the key id from that line. Then run:

```
aws iam get-access-key-last-used --access-key-id <key-id-from-line-75>
```

If the key does not exist, the call fails with NoSuchEntity, and the literal is not a live key. If it returns data, treat the key as live and rotate it.

**PC-10. Whether the 05466 rollback has been applied.** Covers finding 18.

```sql
SELECT to_regclass('legacy_archive.bak_05466_user_tenants_20261102') IS NOT NULL AS backup_present;
```

`t` means VTID-05466 is applied, and the rollback file is a live hazard if it is ever run.

## Migration and test writes to production-only objects (check 4)

No document lists production-only objects. The nearest documented set is `aurora_only_tables`, with nine tables. Writes to those tables appear only in the two placement-guarded migrations (finding 19). Test-side writes go to `services/gateway/test/health-sources/fake-db.ts` and to `scripts/ci/sql-tests/`, which run against CI Postgres (no `auth.users`). No other migration or test writes to them.

## Rules 31, 43 and 44 (check 5)

- Rule 43 (never let a test or service account become visible to a real member): `CLAUDE.md` line 267. Present in CLAUDE.md.
- Rule 44 (register a test account in both allowlists before it is inserted into `user_tenants` or `profiles`): `CLAUDE.md` line 272. Present in CLAUDE.md.
- Rule 31 (never write as the test account): `CLAUDE.md` line 407. A different item numbered 31, at line 155, is also in CLAUDE.md (finding 27).
- None of these rule texts is in `.claude/rules/`, which holds `backend.md`, `collaboration.md` and `infrastructure.md`.

## Known gaps

- The 14 files with dynamic revoke loops were not resolved per function. Appendix A marks where a later loop names a function.
- The phase_c coverage of 210 functions is an inference from the loop text.
- No production state was read. Each "open" result needs PC-1 or the matching check before it is treated as a live exposure.
- The secret scan covers seven pattern families. It is not a full secret scanner.

## Appendix A. Functions with a final member-role EXECUTE grant

Source: explicit GRANT and REVOKE statements in `supabase/migrations`, replayed in file-name order. "Later dynamic revoke loop" lists the later migrations whose `DO` loops contain the function name. Those loops could revoke it at run time.

| # | Function | Member role(s) with last explicit GRANT | Granting migration:line | SECURITY DEFINER | Later explicit REVOKE | Later dynamic revoke loop that names it |
|---|---|---|---|---|---|---|
| 1 | `_index_boost_activity_key` | authenticated | 20260924170000_vtid_04489_index_boost.sql:168 | no | none | none |
| 2 | `accept_recommendation` | authenticated | 20260117100000_vtid_01180_recommendation_inbox.sql:403 | yes | none | none |
| 3 | `activate_autopilot_recommendation` | authenticated | 20260117120000_vtid_01180_autopilot_recommendations.sql:464 | yes | none | none |
| 4 | `add_group_member` | authenticated | 20261102054100_vtid_05579_network_group_rpcs.sql:180 | yes | none | none |
| 5 | `advance_capability_awareness` | authenticated | 20260519000000_VTID_02924_capability_awareness_events.sql:287 | yes | none | none |
| 6 | `ai_connection_authorization_info` | authenticated | 20261013150000_vtid_05133_ai_connection_grants.sql:238 | yes | none | none |
| 7 | `ai_connection_grant_from_authorization` | authenticated | 20261013150000_vtid_05133_ai_connection_grants.sql:239 | yes | none | none |
| 8 | `ai_connection_grant_revoke` | authenticated | 20261013150000_vtid_05133_ai_connection_grants.sql:241 | yes | none | none |
| 9 | `ai_connection_grant_update` | authenticated | 20261013150000_vtid_05133_ai_connection_grants.sql:240 | yes | none | none |
| 10 | `alignment_act_on_suggestion` | authenticated | 20260103000001_vtid_01141_d47_social_alignment_engine.sql:939 | yes | none | none |
| 11 | `alignment_generate_suggestions` | authenticated | 20260103000001_vtid_01141_d47_social_alignment_engine.sql:936 | yes | none | none |
| 12 | `alignment_get_suggestions` | authenticated | 20260103000001_vtid_01141_d47_social_alignment_engine.sql:937 | yes | none | none |
| 13 | `alignment_mark_shown` | authenticated | 20260103000001_vtid_01141_d47_social_alignment_engine.sql:938 | yes | none | none |
| 14 | `availability_clear_override` | authenticated | 20260102200000_vtid_01127_availability_readiness_engine.sql:617 | yes | none | 20261102040400_vtid_05571_writer_fallback_rollback, 20261102040400_vtid_05571_writer_repoint.sql |
| 15 | `availability_compute` | authenticated | 20260102200000_vtid_01127_availability_readiness_engine.sql:614 | yes | none | 20261102040400_vtid_05571_writer_fallback_rollback, 20261102040400_vtid_05571_writer_repoint.sql |
| 16 | `availability_get_override` | authenticated | 20260102200000_vtid_01127_availability_readiness_engine.sql:615 | yes | none | 20261102040400_vtid_05571_writer_fallback_rollback, 20261102040400_vtid_05571_writer_repoint.sql |
| 17 | `availability_get_recent` | authenticated | 20260102200000_vtid_01127_availability_readiness_engine.sql:618 | yes | none | 20261102040400_vtid_05571_writer_fallback_rollback, 20261102040400_vtid_05571_writer_repoint.sql |
| 18 | `availability_set_override` | authenticated | 20260102200000_vtid_01127_availability_readiness_engine.sql:616 | yes | none | 20261102040400_vtid_05571_writer_fallback_rollback, 20261102040400_vtid_05571_writer_repoint.sql |
| 19 | `build_specialist_context` | authenticated | 20260508000000_forwarding_rules_two_gate.sql:425 | yes | none | none |
| 20 | `caller_is_tenant_member` | authenticated | 20260928200400_vtid_04717_risk_mitigations.sql:59 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 21 | `caller_tenant_id` | authenticated | 20260928200300_vtid_04720_preference_modeling_data_layer.sql:59 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 22 | `capacity_compute` | authenticated | 20260102200000_vtid_01122_health_capacity_awareness.sql:1242 | yes | none | none |
| 23 | `capacity_filter_actions` | authenticated | 20260102200000_vtid_01122_health_capacity_awareness.sql:1245 | yes | none | none |
| 24 | `capacity_get_current` | authenticated | 20260102200000_vtid_01122_health_capacity_awareness.sql:1243 | yes | none | none |
| 25 | `capacity_override` | authenticated | 20260102200000_vtid_01122_health_capacity_awareness.sql:1244 | yes | none | none |
| 26 | `catalog_add_product` | authenticated | 20251231100000_vtid_01092_services_products_memory.sql:935 | yes | none | none |
| 27 | `catalog_add_service` | authenticated | 20251231100000_vtid_01092_services_products_memory.sql:934 | yes | none | none |
| 28 | `check_behavior_constraint` | authenticated | 20260102000000_vtid_01121_feedback_trust_repair.sql:1085 | yes | none | none |
| 29 | `check_memory_access_grant` | authenticated | 20251231000001_vtid_01085_memory_retrieve_router.sql:750 | yes | none | none |
| 30 | `check_role_permitted` | authenticated | 20260318100000_role_admission_system.sql:99 | yes | none | none |
| 31 | `cognee_track_extraction` | authenticated | 20260201000000_vtid_01225_cognee_extractor.sql:262 | yes | none | none |
| 32 | `community_create_group` | authenticated | 20251231100000_vtid_01084_community_personalization_v1.sql:1255 | yes | none | none |
| 33 | `community_create_meetup` | authenticated | 20251231100000_vtid_01084_community_personalization_v1.sql:1256 | yes | none | none |
| 34 | `community_get_matching_rules` | authenticated | 20251231100000_vtid_01084_community_personalization_v1.sql:1251 | no | none | none |
| 35 | `community_get_recommendation_explain` | authenticated | 20251231100000_vtid_01084_community_personalization_v1.sql:1254 | yes | none | none |
| 36 | `community_get_recommendations` | authenticated | 20251231100000_vtid_01084_community_personalization_v1.sql:1253 | yes | none | none |
| 37 | `community_join_group` | authenticated | 20251231100000_vtid_01084_community_personalization_v1.sql:1257 | yes | none | none |
| 38 | `community_recompute_recommendations` | authenticated | 20251231100000_vtid_01084_community_personalization_v1.sql:1252 | yes | none | none |
| 39 | `complete_autopilot_recommendation` | authenticated | 20261003130000_vtid_04864_autopilot_completion_no_double_reward.sql:139 | yes | none | none |
| 40 | `compute_intent_matches_v2` | authenticated | 20260924090000_vtid_04460_intent_ledger_embeddings_titan_v2.sql:191 | yes | none | none |
| 41 | `compute_trend_delta` | authenticated | 20251231000001_vtid_01085_memory_retrieve_router.sql:751 | yes | none | none |
| 42 | `compute_user_lifecycle_stage` | authenticated | 20260416120200_vtid_02000_marketplace_helpers.sql:239 | no | none | none |
| 43 | `constraint_delete` | authenticated | 20260928200300_vtid_04720_preference_modeling_data_layer.sql:1276 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 44 | `constraint_set` | authenticated | 20260928200300_vtid_04720_preference_modeling_data_layer.sql:1275 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 45 | `context_assembly_get_bundle_details` | authenticated | 20260102000000_vtid_01112_context_assembly_engine.sql:282 | yes | none | none |
| 46 | `context_assembly_get_history` | authenticated | 20260102000000_vtid_01112_context_assembly_engine.sql:281 | yes | none | none |
| 47 | `count_events_by_stage` | authenticated | 20251209000000_add_task_stage.sql:108 | yes | none | none |
| 48 | `create_network_group` | authenticated | 20261102054100_vtid_05579_network_group_rpcs.sql:169 | yes | none | none |
| 49 | `current_active_role` | authenticated | 20251229000000_vtid_01051_me_active_role_fix.sql:274 | no | none | none |
| 50 | `current_tenant_id` | authenticated | 20260218000000_fix_maxina_signup_tenant_association.sql:105 | no | none | 20261102032100_vtid_05464_tenant_claim_mismatch_lo |
| 51 | `current_user_id` | authenticated | 20251231000000_vtid_01101_phase_a_bootstrap.sql:185 | no | none | none |
| 52 | `d42_get_cached_priority` | authenticated | 20260102000000_vtid_01136_context_fusion_engine.sql:629 | yes | none | none |
| 53 | `d42_get_domain_weights` | authenticated | 20260102000000_vtid_01136_context_fusion_engine.sql:633 | yes | none | none |
| 54 | `d42_get_fusion_history` | authenticated | 20260102000000_vtid_01136_context_fusion_engine.sql:634 | yes | none | none |
| 55 | `d42_invalidate_cache` | authenticated | 20260102000000_vtid_01136_context_fusion_engine.sql:631 | yes | none | none |
| 56 | `d42_set_cached_priority` | authenticated | 20260102000000_vtid_01136_context_fusion_engine.sql:630 | yes | none | none |
| 57 | `d42_store_audit` | authenticated | 20260102000000_vtid_01136_context_fusion_engine.sql:632 | yes | none | none |
| 58 | `discover_category_counts` | anon,authenticated | 20261001140000_vtid_04783_discover_categories.sql:209 | yes | none | none |
| 59 | `discover_tenant_gate_enabled` | authenticated | 20261102120300_vtid_05488_products_merchants_tenant_rls.sql:86 | yes | none | none |
| 60 | `dismiss_recommendation` | authenticated | 20260117100000_vtid_01180_recommendation_inbox.sql:405 | yes | none | none |
| 61 | `emotional_cognitive_compute` | authenticated | 20260102000000_vtid_01120_emotional_cognitive_signals.sql:1061 | yes | none | none |
| 62 | `emotional_cognitive_explain` | authenticated | 20260102000000_vtid_01120_emotional_cognitive_signals.sql:1064 | yes | none | none |
| 63 | `emotional_cognitive_get_current` | authenticated | 20260102000000_vtid_01120_emotional_cognitive_signals.sql:1062 | yes | none | none |
| 64 | `emotional_cognitive_override` | authenticated | 20260102000000_vtid_01120_emotional_cognitive_signals.sql:1063 | yes | none | none |
| 65 | `fn_get_feature_usage` | authenticated | 20260526040000_VTID_03107_usage_helpers.sql:133 | yes | none | none |
| 66 | `fn_get_feature_usage_in_window` | authenticated | 20260526100000_VTID_03107_rolling_windows.sql:120 | yes | none | none |
| 67 | `fn_increment_feature_usage` | authenticated | 20260526040000_VTID_03107_usage_helpers.sql:83 | yes | none | none |
| 68 | `fn_redeem_code` | authenticated | 20260526060000_VTID_03107_redemption_codes.sql:340 | yes | none | none |
| 69 | `get_autopilot_analyzer_sources` | authenticated | 20260117130000_vtid_01185_recommendation_engine.sql:508 | yes | none | none |
| 70 | `get_autopilot_recommendation_history` | authenticated | 20260117130000_vtid_01185_recommendation_engine.sql:513 | yes | none | none |
| 71 | `get_autopilot_recommendations` | authenticated | 20260519000000_BOOTSTRAP_autopilot_alignment_fields.sql:233 | yes | none | none |
| 72 | `get_autopilot_recommendations_count` | authenticated | 20260117120000_vtid_01180_autopilot_recommendations.sql:470 | yes | none | none |
| 73 | `get_behavior_constraints` | authenticated | 20260102000000_vtid_01121_feedback_trust_repair.sql:842 | yes | none | none |
| 74 | `get_correction_history` | authenticated | 20260102000000_vtid_01121_feedback_trust_repair.sql:1019 | yes | none | none |
| 75 | `get_index_boost` | authenticated | 20260924170000_vtid_04489_index_boost.sql:165 | yes | none | none |
| 76 | `get_index_standing` | authenticated | 20260924190000_vtid_04498_index_standing.sql:107 | yes | none | none |
| 77 | `get_live_room_summary` | authenticated | 20251231000001_vtid_01090_live_rooms_events_graph.sql:1262 | yes | none | none |
| 78 | `get_my_permitted_roles` | authenticated | 20260318100000_role_admission_system.sql:401 | yes | none | none |
| 79 | `get_personalization_changes` | authenticated | 20251231000001_vtid_01094_match_feedback_loop.sql:810 | yes | none | none |
| 80 | `get_profile_health_summary` | authenticated | 20260924150000_vtid_04483_profile_health_summary.sql:240 | yes | none | none |
| 81 | `get_public_vitana_index` | anon,authenticated | 20260424000001_public_vitana_index_rpc.sql:70 | yes | none | 20260608130000_phase_c_rpc_anon_lockdown.sql |
| 82 | `get_recent_conversations` | authenticated | 20260315000002_rpc_add_message_type.sql:56 | yes | none | 20260608130000_phase_c_rpc_anon_lockdown.sql |
| 83 | `get_recommendation_inbox` | authenticated | 20260117100000_vtid_01180_recommendation_inbox.sql:397 | yes | none | none |
| 84 | `get_recommendation_inbox_count` | authenticated | 20260117100000_vtid_01180_recommendation_inbox.sql:399 | yes | none | none |
| 85 | `get_trust_scores` | authenticated | 20260102000000_vtid_01121_feedback_trust_repair.sql:780 | yes | none | none |
| 86 | `get_user_limitations_impact` | authenticated | 20260416120200_vtid_02000_marketplace_helpers.sql:242 | yes | none | none |
| 87 | `get_user_profile` | authenticated | 20260119100000_vtid_01186_profile_avatar.sql:85 | yes | none | none |
| 88 | `get_user_profile_by_identifier` | anon,authenticated | 20261010164100_vtid_05041_definer_functions_lockdown.sql:135 | yes | none | none |
| 89 | `health_compute_features_daily` | authenticated | 20251231000000_vtid_01103_health_compute_engine.sql:594 | yes | none | none |
| 90 | `health_compute_vitana_index` | authenticated | 20261014140000_vtid_05168_index_movements.sql:349 | yes | none | none |
| 91 | `health_generate_recommendations` | authenticated | 20251231000000_vtid_01103_health_compute_engine.sql:596 | yes | none | none |
| 92 | `health_get_summary` | authenticated | 20251231000000_vtid_01078_health_brain_phase_c1.sql:893 | yes | none | none |
| 93 | `health_ingest_lab_report` | authenticated | 20251231000000_vtid_01078_health_brain_phase_c1.sql:617 | yes | none | none |
| 94 | `inference_downgrade` | authenticated | 20260928200300_vtid_04720_preference_modeling_data_layer.sql:1280 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 95 | `inference_reinforce` | authenticated | 20260928200300_vtid_04720_preference_modeling_data_layer.sql:1279 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 96 | `is_chat_group_member` | anon,authenticated | 20260522010000_chat_group_members_recursion_fix.sql:46 | yes | none | none |
| 97 | `is_in_quiet_hours` | authenticated | 20260928200000_vtid_04716_autopilot_prompts_data_layer.sql:260 | no | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 98 | `is_partner_org_member` | anon,authenticated | 20260923120000_vtid_04337_partner_org_members_rls_no_recursion.sql:49 | yes | none | none |
| 99 | `is_tenant_moderator` | authenticated | 20261102070100_vtid_05491_mt_tenant_admin_p2_moderation.sql:115 | yes | none | none |
| 100 | `is_user_blocked` | authenticated | 20251231000001_vtid_01094_match_feedback_loop.sql:849 | yes | none | none |
| 101 | `is_user_dampened` | authenticated | 20251231000001_vtid_01094_match_feedback_loop.sql:888 | yes | none | none |
| 102 | `life_stage_assess` | authenticated | 20260102100000_vtid_01124_life_stage_awareness.sql:474 | yes | none | none |
| 103 | `life_stage_detect_goal` | authenticated | 20260102100000_vtid_01124_life_stage_awareness.sql:478 | yes | none | none |
| 104 | `life_stage_explain` | authenticated | 20260102100000_vtid_01124_life_stage_awareness.sql:477 | yes | none | none |
| 105 | `life_stage_get_current` | authenticated | 20260102100000_vtid_01124_life_stage_awareness.sql:475 | yes | none | none |
| 106 | `life_stage_get_goals` | authenticated | 20260102100000_vtid_01124_life_stage_awareness.sql:479 | yes | none | none |
| 107 | `life_stage_override` | authenticated | 20260102100000_vtid_01124_life_stage_awareness.sql:476 | yes | none | none |
| 108 | `life_stage_score_trajectory` | authenticated | 20260102100000_vtid_01124_life_stage_awareness.sql:481 | yes | none | none |
| 109 | `life_stage_update_goal` | authenticated | 20260102100000_vtid_01124_life_stage_awareness.sql:480 | yes | none | none |
| 110 | `lifestyle_profile_get` | authenticated | 20260928200200_vtid_04719_taste_alignment_data_layer.sql:1050 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 111 | `lifestyle_profile_set` | authenticated | 20260928200200_vtid_04719_taste_alignment_data_layer.sql:1051 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 112 | `list_public_tenants` | anon,authenticated | 20261014000600_vtid_05151_public_tenant_registry.sql:156 | yes | none | none |
| 113 | `live_add_highlight` | authenticated | 20251231000001_vtid_01090_live_rooms_events_graph.sql:1002 | yes | none | none |
| 114 | `live_room_create` | authenticated | 20260210000000_vtid_01090_fix_live_room_creation.sql:102 | yes | none | none |
| 115 | `live_room_end` | authenticated | 20251231000001_vtid_01090_live_rooms_events_graph.sql:657 | yes | none | none |
| 116 | `live_room_join` | authenticated | 20251231000001_vtid_01090_live_rooms_events_graph.sql:796 | yes | none | none |
| 117 | `live_room_leave` | authenticated | 20251231000001_vtid_01090_live_rooms_events_graph.sql:874 | yes | none | none |
| 118 | `live_room_start` | authenticated | 20251231000001_vtid_01090_live_rooms_events_graph.sql:552 | yes | none | none |
| 119 | `location_add` | authenticated | 20251231000001_vtid_01091_locations_memory_graph.sql:1204 | yes | none | none |
| 120 | `location_checkin` | authenticated | 20251231000001_vtid_01091_locations_memory_graph.sql:1205 | yes | none | none |
| 121 | `location_get_visits` | authenticated | 20251231000001_vtid_01091_locations_memory_graph.sql:1207 | yes | none | none |
| 122 | `location_nearby_discovery` | authenticated | 20251231000001_vtid_01091_locations_memory_graph.sql:1206 | yes | none | none |
| 123 | `location_preferences_get` | authenticated | 20251231000001_vtid_01091_locations_memory_graph.sql:1208 | yes | none | none |
| 124 | `location_preferences_set` | authenticated | 20251231000001_vtid_01091_locations_memory_graph.sql:1209 | yes | none | none |
| 125 | `longevity_compute_daily` | authenticated | 20251231000001_vtid_01083_longevity_signal_layer.sql:814 | yes | none | none |
| 126 | `longevity_explain_daily` | authenticated | 20251231000001_vtid_01083_longevity_signal_layer.sql:816 | yes | none | none |
| 127 | `longevity_get_daily` | authenticated | 20251231000001_vtid_01083_longevity_signal_layer.sql:815 | yes | none | none |
| 128 | `mark_recommendation_read` | authenticated | 20260117100000_vtid_01180_recommendation_inbox.sql:401 | yes | none | none |
| 129 | `match_compute_score` | authenticated | 20251231000001_vtid_01088_matchmaking_engine.sql:1162 | yes | none | none |
| 130 | `match_get_daily` | authenticated | 20251231000001_vtid_01088_matchmaking_engine.sql:1164 | yes | none | none |
| 131 | `match_get_longevity_deltas` | authenticated | 20251231000001_vtid_01088_matchmaking_engine.sql:1160 | yes | none | none |
| 132 | `match_get_relationship_proximity` | authenticated | 20251231000001_vtid_01088_matchmaking_engine.sql:1161 | yes | none | none |
| 133 | `match_get_user_topics` | authenticated | 20251231000001_vtid_01088_matchmaking_engine.sql:1159 | yes | none | none |
| 134 | `match_recompute_daily` | authenticated | 20251231000001_vtid_01088_matchmaking_engine.sql:1163 | yes | none | none |
| 135 | `match_register_target` | authenticated | 20251231000001_vtid_01088_matchmaking_engine.sql:1166 | yes | none | none |
| 136 | `match_set_state` | authenticated | 20251231000001_vtid_01088_matchmaking_engine.sql:1165 | yes | none | none |
| 137 | `me_context` | authenticated | 20251229000000_vtid_01051_me_active_role_fix.sql:267 | yes | none | none |
| 138 | `me_set_active_role` | authenticated | 20251229000000_vtid_01051_me_active_role_fix.sql:270 | yes | none | none |
| 139 | `meetup_rsvp` | authenticated | 20251231000001_vtid_01090_live_rooms_events_graph.sql:1173 | yes | none | none |
| 140 | `mem_episodes_semantic_search` | authenticated | 20260428160000_vtid_02050_mem_episodes_semantic_search.sql:134 | no | none | none |
| 141 | `memory_add_diary_entry` | authenticated | 20251231100000_vtid_01082_memory_garden_diary.sql:906 | yes | none | none |
| 142 | `memory_adjust_confidence` | authenticated | 20260101000000_vtid_01116_memory_confidence_trust_engine.sql:1032 | yes | none | none |
| 143 | `memory_apply_time_decay` | authenticated | 20260101000000_vtid_01116_memory_confidence_trust_engine.sql:1037 | yes | none | none |
| 144 | `memory_build_timeline` | authenticated | 20251231000001_vtid_01098_memory_timeline_causality.sql:541 | yes | none | none |
| 145 | `memory_calculate_adjustment_delta` | authenticated | 20260101000000_vtid_01116_memory_confidence_trust_engine.sql:1031 | no | none | none |
| 146 | `memory_compute_initial_confidence` | authenticated | 20260101000000_vtid_01116_memory_confidence_trust_engine.sql:1030 | no | none | none |
| 147 | `memory_compute_quality` | authenticated | 20251231100000_vtid_01100_memory_quality_metrics.sql:544 | yes | none | none |
| 148 | `memory_confirm_item` | authenticated | 20260101000000_vtid_01116_memory_confidence_trust_engine.sql:1033 | yes | none | none |
| 149 | `memory_correct_item` | authenticated | 20260101000000_vtid_01116_memory_confidence_trust_engine.sql:1034 | yes | none | none |
| 150 | `memory_delete_entity` | authenticated | 20251231100000_vtid_01099_memory_governance_v1.sql:988 | yes | none | none |
| 151 | `memory_extract_garden_nodes` | authenticated | 20251231100000_vtid_01082_memory_garden_diary.sql:908 | yes | none | none |
| 152 | `memory_facts_semantic_search` | authenticated | 20260221000000_fix_embedding_dimensions_768.sql:94 | yes | none | 20261010164100_vtid_05041_definer_functions_lockdo, 20261013090000_vtid_05125_memory_functions_revoke_ |
| 153 | `memory_garden_node_upsert` | authenticated | 20251231100000_vtid_01082_memory_garden_diary.sql:909 | yes | none | none |
| 154 | `memory_get_confidence_history` | authenticated | 20260101000000_vtid_01116_memory_confidence_trust_engine.sql:1035 | yes | none | none |
| 155 | `memory_get_context` | authenticated | 20251231000000_vtid_01104_memory_core_v1.sql:334 | yes | none | none |
| 156 | `memory_get_context_for_personalization` | authenticated | 20251231100000_vtid_01099_memory_governance_v1.sql:1208 | yes | none | none |
| 157 | `memory_get_context_with_confidence` | authenticated | 20260101000000_vtid_01116_memory_confidence_trust_engine.sql:1036 | yes | none | none |
| 158 | `memory_get_diary_entries` | authenticated | 20251231100000_vtid_01082_memory_garden_diary.sql:907 | yes | none | none |
| 159 | `memory_get_export_status` | authenticated | 20251231100000_vtid_01099_memory_governance_v1.sql:990 | yes | none | none |
| 160 | `memory_get_garden_progress` | authenticated | 20251231000001_vtid_01086_memory_garden_progress.sql:199 | yes | none | none |
| 161 | `memory_get_garden_summary` | authenticated | 20251231100000_vtid_01082_memory_garden_diary.sql:910 | yes | none | none |
| 162 | `memory_get_locked_entities` | authenticated | 20251231100000_vtid_01099_memory_governance_v1.sql:992 | yes | none | none |
| 163 | `memory_get_quality` | authenticated | 20251231100000_vtid_01100_memory_quality_metrics.sql:545 | yes | none | none |
| 164 | `memory_get_settings` | authenticated | 20251231100000_vtid_01099_memory_governance_v1.sql:991 | yes | none | none |
| 165 | `memory_get_timeline` | authenticated | 20251231000001_vtid_01098_memory_timeline_causality.sql:542 | yes | none | none |
| 166 | `memory_is_entity_deleted` | authenticated | 20251231100000_vtid_01099_memory_governance_v1.sql:994 | yes | none | none |
| 167 | `memory_is_entity_locked` | authenticated | 20251231100000_vtid_01099_memory_governance_v1.sql:993 | yes | none | none |
| 168 | `memory_lock_entity` | authenticated | 20251231100000_vtid_01099_memory_governance_v1.sql:986 | yes | none | none |
| 169 | `memory_map_source_classification` | authenticated | 20260101000000_vtid_01116_memory_confidence_trust_engine.sql:1029 | no | none | none |
| 170 | `memory_request_export` | authenticated | 20251231100000_vtid_01099_memory_governance_v1.sql:989 | yes | none | none |
| 171 | `memory_retrieve` | authenticated | 20251231000001_vtid_01085_memory_retrieve_router.sql:749 | yes | none | none |
| 172 | `memory_semantic_search` | authenticated | 20260117140000_vtid_01184_pgvector_semantic_memory.sql:583 | no | none | none |
| 173 | `memory_set_visibility` | authenticated | 20251231100000_vtid_01099_memory_governance_v1.sql:985 | yes | none | none |
| 174 | `memory_unlock_entity` | authenticated | 20251231100000_vtid_01099_memory_governance_v1.sql:987 | yes | none | none |
| 175 | `memory_write_item` | authenticated | 20251231000000_vtid_01104_memory_core_v1.sql:333 | yes | none | none |
| 176 | `memory_write_item_v2` | authenticated | 20260117140000_vtid_01184_pgvector_semantic_memory.sql:587 | yes | none | none |
| 177 | `moderation_list_reports` | authenticated | 20261102070150_vtid_05491_mt_tenant_admin_p3_moderation.sql:119 | yes | none | none |
| 178 | `moderation_resolve_report` | authenticated | 20261102070150_vtid_05491_mt_tenant_admin_p3_moderation.sql:120 | yes | none | none |
| 179 | `moderator_tenant_scope_enabled` | authenticated | 20261102070600_vtid_05491_mt_moderator_tenant_scope.sql:74 | yes | none | none |
| 180 | `monetization_check_gating` | authenticated | 20260102200000_vtid_01130_financial_monetization_engine.sql:998 | yes | none | none |
| 181 | `monetization_get_active_cooldowns` | authenticated | 20260102200000_vtid_01130_financial_monetization_engine.sql:996 | yes | none | none |
| 182 | `monetization_get_history` | authenticated | 20260102200000_vtid_01130_financial_monetization_engine.sql:997 | yes | none | none |
| 183 | `monetization_record_attempt` | authenticated | 20260102200000_vtid_01130_financial_monetization_engine.sql:995 | yes | none | none |
| 184 | `monetization_record_signal` | authenticated | 20260102200000_vtid_01130_financial_monetization_engine.sql:994 | yes | none | none |
| 185 | `offers_get_memory` | authenticated | 20251231100000_vtid_01092_services_products_memory.sql:939 | yes | none | none |
| 186 | `offers_get_recommendations` | authenticated | 20251231100000_vtid_01092_services_products_memory.sql:938 | yes | none | none |
| 187 | `offers_record_outcome` | authenticated | 20251231100000_vtid_01092_services_products_memory.sql:937 | yes | none | none |
| 188 | `offers_set_state` | authenticated | 20251231100000_vtid_01092_services_products_memory.sql:936 | yes | none | none |
| 189 | `overload_compute_baselines` | authenticated | 20260928200100_vtid_04718_overload_detection_data_layer.sql:1101 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 190 | `overload_detect` | authenticated | 20260928200100_vtid_04718_overload_detection_data_layer.sql:1103 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 191 | `overload_dismiss` | authenticated | 20260928200100_vtid_04718_overload_detection_data_layer.sql:1105 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 192 | `overload_explain` | authenticated | 20260928200100_vtid_04718_overload_detection_data_layer.sql:1107 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 193 | `overload_get_baselines` | authenticated | 20260928200100_vtid_04718_overload_detection_data_layer.sql:1102 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 194 | `overload_get_detections` | authenticated | 20260928200100_vtid_04718_overload_detection_data_layer.sql:1104 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 195 | `overload_record_pattern` | authenticated | 20260928200100_vtid_04718_overload_detection_data_layer.sql:1106 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 196 | `pick_specialist_for_text` | authenticated | 20260508001000_forwarding_rules_drop_old_rpc.sql:124 | yes | none | none |
| 197 | `pick_specialist_for_text_tenant` | authenticated | 20260508002000_forwarding_rules_tenant_two_gate.sql:169 | yes | none | none |
| 198 | `preference_bundle_get` | authenticated | 20260928200300_vtid_04720_preference_modeling_data_layer.sql:1277 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 199 | `preference_confirm` | authenticated | 20260928200300_vtid_04720_preference_modeling_data_layer.sql:1278 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 200 | `preference_delete` | authenticated | 20260928200300_vtid_04720_preference_modeling_data_layer.sql:1274 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 201 | `preference_get_audit` | authenticated | 20260928200300_vtid_04720_preference_modeling_data_layer.sql:1281 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 202 | `preference_set` | authenticated | 20260928200300_vtid_04720_preference_modeling_data_layer.sql:1273 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 203 | `record_match_feedback` | authenticated | 20251231000001_vtid_01094_match_feedback_loop.sql:732 | yes | none | none |
| 204 | `record_user_correction` | authenticated | 20260102000000_vtid_01121_feedback_trust_repair.sql:722 | yes | none | none |
| 205 | `reject_autopilot_recommendation` | authenticated | 20260117120000_vtid_01180_autopilot_recommendations.sql:466 | yes | none | none |
| 206 | `relationship_add_edge` | authenticated | 20251231000001_vtid_01087_relationship_graph_memory.sql:796 | yes | none | none |
| 207 | `relationship_edge_strengthen` | authenticated | 20251231000001_vtid_01091_locations_memory_graph.sql:1210 | yes | none | none |
| 208 | `relationship_ensure_node` | authenticated | 20251231000001_vtid_01087_relationship_graph_memory.sql:795 | yes | none | none |
| 209 | `relationship_get_graph` | authenticated | 20251231000001_vtid_01087_relationship_graph_memory.sql:797 | yes | none | none |
| 210 | `relationship_get_signals` | authenticated | 20251231000001_vtid_01087_relationship_graph_memory.sql:799 | yes | none | none |
| 211 | `relationship_update_signal` | authenticated | 20251231000001_vtid_01087_relationship_graph_memory.sql:798 | yes | none | none |
| 212 | `repair_trust` | authenticated | 20260102000000_vtid_01121_feedback_trust_repair.sql:934 | yes | none | none |
| 213 | `request_connection` | authenticated | 20261102051100_vtid_05582_connection_rpcs.sql:99 | yes | none | none |
| 214 | `resolve_tenant` | anon,authenticated | 20261102140100_vtid_05507_mt_resolve_tenant_host.sql:72 | yes | none | none |
| 215 | `respond_connection` | authenticated | 20261102051100_vtid_05582_connection_rpcs.sql:130 | yes | none | none |
| 216 | `search_intent_catalog_v2` | authenticated | 20260924090000_vtid_04460_intent_ledger_embeddings_titan_v2.sql:192 | yes | none | none |
| 217 | `search_knowledge_docs` | authenticated | 20251213000000_knowledge_docs.sql:125 | yes | none | none |
| 218 | `semantic_memory_search` | authenticated | 20260221000000_fix_embedding_dimensions_768.sql:179 | yes | none | none |
| 219 | `send_message` | authenticated | 20261102050100_vtid_05576_send_message_rpcs.sql:173 | yes | none | none |
| 220 | `set_role_preference` | authenticated | 20261013233000_vtid_05147_s_m_membership_role_lockdown.sql:133 | yes | none | none |
| 221 | `snooze_autopilot_recommendation` | authenticated | 20260117120000_vtid_01180_autopilot_recommendations.sql:468 | yes | none | none |
| 222 | `snooze_recommendation` | authenticated | 20260117100000_vtid_01180_recommendation_inbox.sql:407 | yes | none | none |
| 223 | `social_compute_context` | authenticated | 20260102000001_vtid_01129_social_context_relationships.sql:1180 | yes | none | none |
| 224 | `social_compute_proximity` | authenticated | 20260102000001_vtid_01129_social_context_relationships.sql:1178 | yes | none | none |
| 225 | `social_get_comfort_profile` | authenticated | 20260102000001_vtid_01129_social_context_relationships.sql:1176 | yes | none | none |
| 226 | `social_get_relevant_connections` | authenticated | 20260102000001_vtid_01129_social_context_relationships.sql:1179 | yes | none | none |
| 227 | `social_invalidate_cache` | authenticated | 20260102000001_vtid_01129_social_context_relationships.sql:1181 | yes | none | none |
| 228 | `social_update_comfort_profile` | authenticated | 20260102000001_vtid_01129_social_context_relationships.sql:1177 | yes | none | none |
| 229 | `submit_recommendation_feedback` | authenticated | 20260117100000_vtid_01180_recommendation_inbox.sql:409 | yes | none | none |
| 230 | `switch_to_tenant_by_slug` | authenticated | 20261102070350_vtid_05493_mt_tenant_archive_switch.sql:219 | yes | none | none |
| 231 | `taste_alignment_audit_get` | authenticated | 20260928200200_vtid_04719_taste_alignment_data_layer.sql:1054 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 232 | `taste_alignment_bundle_get` | authenticated | 20260928200200_vtid_04719_taste_alignment_data_layer.sql:1052 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 233 | `taste_profile_get` | authenticated | 20260928200200_vtid_04719_taste_alignment_data_layer.sql:1048 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 234 | `taste_profile_set` | authenticated | 20260928200200_vtid_04719_taste_alignment_data_layer.sql:1049 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 235 | `taste_reaction_record` | authenticated | 20260928200200_vtid_04719_taste_alignment_data_layer.sql:1053 | yes | none | 20260928200500_vtid_04716_feature_functions_no_ano |
| 236 | `topics_create_registry_entry` | authenticated | 20251231000001_vtid_01093_topics_layer.sql:717 | yes | none | none |
| 237 | `topics_get_registry` | authenticated | 20251231000001_vtid_01093_topics_layer.sql:718 | yes | none | none |
| 238 | `topics_get_user_profile` | authenticated | 20251231000001_vtid_01093_topics_layer.sql:714 | yes | none | none |
| 239 | `topics_recompute_user_profile` | authenticated | 20251231000001_vtid_01093_topics_layer.sql:715 | yes | none | none |
| 240 | `topics_validate_keys` | authenticated | 20251231000001_vtid_01093_topics_layer.sql:716 | yes | none | none |
| 241 | `update_user_balance` | authenticated | 20261001180000_vtid_04809_vtna_reward_ledger.sql:284 | yes | none | none |
| 242 | `update_user_profile` | authenticated | 20260119100000_vtid_01186_profile_avatar.sql:140 | yes | none | none |
| 243 | `upsert_relationship_edge` | authenticated | 20251231000001_vtid_01090_live_rooms_events_graph.sql:409 | yes | none | none |

## Appendix B. Personal-data candidate tables and RLS status

Source: `CREATE TABLE` statements in `supabase/migrations`. Candidates are matched by name keyword. Status combines static `ENABLE ROW LEVEL SECURITY` and the DO loops named in the text above.

| Table | Created at | RLS and policy status |
|---|---|---|
| `vtid_ledger` | 20251217000000_vtid_ledger_and_allocator.sql:19 | RLS on (static); policies=2 |
| `user_active_roles` | 20251229000000_vtid_01051_me_active_role_fix.sql:110 | RLS on (static); policies=3 |
| `lab_reports` | 20251231000000_vtid_01078_health_brain_phase_c1.sql:61 | RLS on (static); policies=5 |
| `health_features_daily` | 20251231000000_vtid_01078_health_brain_phase_c1.sql:118 | RLS on (static); policies=5 |
| `tenants` | 20251231000000_vtid_01101_phase_a_bootstrap.sql:29 | RLS on (static); policies=2 |
| `app_users` | 20251231000000_vtid_01101_phase_a_bootstrap.sql:57 | RLS on (static); policies=3 |
| `user_tenants` | 20251231000000_vtid_01101_phase_a_bootstrap.sql:90 | RLS on (static); policies=4 |
| `memory_categories` | 20251231000000_vtid_01104_memory_core_v1.sql:16 | RLS on (static); policies=1 |
| `memory_items` | 20251231000000_vtid_01104_memory_core_v1.sql:41 | RLS on (static); policies=5 |
| `memory_retrieve_audit` | 20251231000001_vtid_01085_memory_retrieve_router.sql:21 | RLS on (static); policies=2 |
| `memory_access_grants` | 20251231000001_vtid_01085_memory_retrieve_router.sql:54 | RLS on (static); policies=2 |
| `memory_garden_nodes` | 20251231000001_vtid_01085_memory_retrieve_router.sql:89 | RLS on (static); policies=7 |
| `memory_garden_config` | 20251231000001_vtid_01086_memory_garden_progress.sql:17 | RLS on (static); policies=1 |
| `memory_category_mapping` | 20251231000001_vtid_01086_memory_garden_progress.sql:67 | RLS on (static); policies=1 |
| `relationship_nodes` | 20251231000001_vtid_01087_relationship_graph_memory.sql:25 | RLS on (static); policies=13 |
| `relationship_edges` | 20251231000001_vtid_01087_relationship_graph_memory.sql:54 | RLS on (static); policies=16 |
| `relationship_signals` | 20251231000001_vtid_01087_relationship_graph_memory.sql:99 | RLS on (static); policies=4 |
| `match_targets` | 20251231000001_vtid_01088_matchmaking_engine.sql:95 | RLS on (static); policies=9 |
| `matches_daily` | 20251231000001_vtid_01088_matchmaking_engine.sql:127 | RLS on (static); policies=4 |
| `user_match_preferences` | 20251231000001_vtid_01088_matchmaking_engine.sql:203 | RLS on (static); policies=1 |
| `locations` | 20251231000001_vtid_01091_locations_memory_graph.sql:27 | RLS on (static); policies=4 |
| `location_visits` | 20251231000001_vtid_01091_locations_memory_graph.sql:73 | RLS on (static); policies=4 |
| `location_preferences` | 20251231000001_vtid_01091_locations_memory_graph.sql:104 | RLS on (static); policies=3 |
| `user_topic_profile` | 20251231000001_vtid_01093_topics_layer.sql:41 | RLS on (static); policies=8 |
| `match_feedback` | 20251231000001_vtid_01094_match_feedback_loop.sql:213 | RLS on (static); policies=3 |
| `user_blocklist` | 20251231000001_vtid_01094_match_feedback_loop.sql:309 | RLS on (static); policies=4 |
| `user_dampening` | 20251231000001_vtid_01094_match_feedback_loop.sql:364 | RLS on (static); policies=4 |
| `memory_timeline_snapshots` | 20251231000001_vtid_01098_memory_timeline_causality.sql:32 | RLS on (static); policies=4 |
| `memory_diary_entries` | 20251231100000_vtid_01082_memory_garden_diary.sql:27 | RLS on (static); policies=4 |
| `memory_node_sources` | 20251231100000_vtid_01082_memory_garden_diary.sql:88 | RLS on (static); policies=3 |
| `community_memberships` | 20251231100000_vtid_01084_community_personalization_v1.sql:81 | RLS on (static); policies=4 |
| `user_offers_memory` | 20251231100000_vtid_01092_services_products_memory.sql:68 | RLS on (static); policies=3 |
| `memory_visibility_prefs` | 20251231100000_vtid_01099_memory_governance_v1.sql:19 | RLS on (static); policies=4 |
| `memory_locks` | 20251231100000_vtid_01099_memory_governance_v1.sql:38 | RLS on (static); policies=3 |
| `memory_deletions` | 20251231100000_vtid_01099_memory_governance_v1.sql:60 | RLS on (static); policies=2 |
| `memory_exports` | 20251231100000_vtid_01099_memory_governance_v1.sql:85 | RLS on (static); policies=3 |
| `memory_quality_metrics` | 20251231100000_vtid_01100_memory_quality_metrics.sql:18 | RLS on (static); policies=3 |
| `memory_source_trust` | 20260101000000_vtid_01116_memory_confidence_trust_engine.sql:26 | RLS on (static); policies=1 |
| `memory_confidence_reasons` | 20260101000000_vtid_01116_memory_confidence_trust_engine.sql:60 | RLS on (static); policies=1 |
| `memory_confidence_history` | 20260101000000_vtid_01116_memory_confidence_trust_engine.sql:160 | RLS on (static); policies=2 |
| `user_corrections` | 20260102000000_vtid_01121_feedback_trust_repair.sql:53 | RLS on (static); policies=4 |
| `social_comfort_profiles` | 20260102000001_vtid_01129_social_context_relationships.sql:26 | RLS on (static); policies=4 |
| `user_preferences` | 20260102100000_vtid_01119_user_preference_modeling_v1.sql:43 | RLS on (static); policies=4 |
| `user_preference_inferences` | 20260102100000_vtid_01119_user_preference_modeling_v1.sql:77 | RLS on (static); policies=8 |
| `user_constraints` | 20260102100000_vtid_01119_user_preference_modeling_v1.sql:116 | RLS on (static); policies=8 |
| `user_preference_bundles` | 20260102100000_vtid_01119_user_preference_modeling_v1.sql:156 | RLS on (static); policies=6 |
| `user_preference_audit` | 20260102100000_vtid_01119_user_preference_modeling_v1.sql:184 | RLS on (static); policies=4 |
| `user_taste_profiles` | 20260102110000_vtid_01133_taste_alignment_engine_v1.sql:21 | RLS on (static); policies=6 |
| `user_lifestyle_profiles` | 20260102110000_vtid_01133_taste_alignment_engine_v1.sql:64 | RLS on (static); policies=6 |
| `value_profiles` | 20260102200000_vtid_01130_financial_monetization_engine.sql:189 | RLS on (static); policies=3 |
| `memory_facts` | 20260119000000_vtid_01192_infinite_memory_v2.sql:20 | RLS on (static); policies=2 |
| `live_room_sessions` | 20260210100000_vtid_01228_live_room_session_mgmt.sql:48 | RLS on (static); policies=3 |
| `user_device_tokens` | 20260225000000_notification_system.sql:6 | RLS on (static); policies=2 |
| `user_notifications` | 20260225000000_notification_system.sql:24 | RLS on (static); policies=4 |
| `user_notification_preferences` | 20260225000000_notification_system.sql:55 | RLS on (static); policies=2 |
| `chat_messages` | 20260225200000_chat_messages.sql:6 | RLS on (static); policies=10 |
| `conversation_messages` | 20260226000000_conversation_messages.sql:22 | RLS on (static); policies=3 |
| `user_feedback_reports` | 20260227100000_user_feedback_reports.sql:7 | RLS on (static); policies=3 |
| `user_consents` | 20260317000000_openclaw_bridge_tables.sql:35 | RLS on (static); policies=2 |
| `wallet_transactions` | 20260318000000_vtid_01250_autopilot_automations_engine.sql:49 | RLS on (static); policies=3 |
| `wallet_balances` | 20260318000000_vtid_01250_autopilot_automations_engine.sql:86 | RLS on (static); policies=3 |
| `user_permitted_roles` | 20260318100000_role_admission_system.sql:21 | RLS on (static); policies=2 |
| `oasis_spec_quality_reports` | 20260318100000_spec_quality_reports.sql:5 | RLS on (static); policies=1 |
| `social_connections` | 20260327000000_vtid_01250_social_connections.sql:10 | RLS on (static); policies=2 |
| `tenant_invitations` | 20260412000000_tenant_invitations.sql:9 | RLS on (static); policies=4 |
| `tenant_autopilot_settings` | 20260412100000_tenant_autopilot_config.sql:8 | RLS on (static); policies=4 |
| `tenant_autopilot_bindings` | 20260412100000_tenant_autopilot_config.sql:26 | RLS on (static); policies=4 |
| `tenant_autopilot_runs` | 20260412100000_tenant_autopilot_config.sql:44 | RLS on (static); policies=4 |
| `tenant_assistant_config` | 20260412200000_tenant_assistant_config.sql:9 | RLS on (static); policies=3 |
| `tenant_kb_baseline_optouts` | 20260412200000_tenant_assistant_config.sql:119 | RLS on (static); policies=2 |
| `tenant_settings` | 20260412300000_tenant_settings.sql:8 | RLS on (static); policies=3 |
| `tenant_admin_audit_log` | 20260412300000_tenant_settings.sql:43 | RLS on (static); policies=3 |
| `notification_categories` | 20260416000000_notification_categories.sql:11 | RLS on (static); policies=2 |
| `user_category_preferences` | 20260416000000_notification_categories.sql:45 | RLS on (static); policies=2 |
| `tenant_catalog_overrides` | 20260416120000_vtid_02000_marketplace_foundation.sql:326 | RLS on (static); policies=4 |
| `user_limitations` | 20260416120000_vtid_02000_marketplace_foundation.sql:393 | RLS on (static); policies=4 |
| `product_orders` | 20260416120000_vtid_02000_marketplace_foundation.sql:527 | RLS on (static); policies=6 |
| `canonical_fact_key_review_queue` | 20260416120000_vtid_02000_marketplace_foundation.sql:634 | RLS on (static); policies=1 |
| `user_connections` | 20260417000000_vtid_02100_connector_framework.sql:45 | RLS on (static); policies=4 |
| `user_active_role` | 20260418000000_proactive_guide_phase0.sql:48 | RLS on (static); policies=1 |
| `user_journey_overrides` | 20260418000000_proactive_guide_phase0.sql:69 | RLS on (static); policies=1 |
| `user_nudge_state` | 20260418000000_proactive_guide_phase0.sql:132 | RLS on (static); policies=1 |
| `user_proactive_pause` | 20260418000000_proactive_guide_phase0.sql:172 | RLS on (static); policies=1 |
| `action_ledger` | 20260418020000_vtid_02300_outbound_actions.sql:92 | RLS on (static); policies=2 |
| `user_action_permissions` | 20260418020000_vtid_02300_outbound_actions.sql:135 | RLS on (static); policies=3 |
| `tenant_assistant_speeches` | 20260418060000_tenant_assistant_speeches.sql:11 | RLS on (static); policies=2 |
| `ai_assistant_credentials` | 20260419000000_vtid_02403_ai_assistants_phase1.sql:136 | RLS on (static); policies=2 |
| `user_feature_introductions` | 20260419100000_user_feature_introductions.sql:16 | RLS on (static); policies=1 |
| `user_session_summaries` | 20260419110000_user_session_summaries.sql:16 | RLS on (static); policies=1 |
| `user_routines` | 20260419120000_user_routines.sql:25 | RLS on (static); policies=1 |
| `user_proactive_touches` | 20260419130000_user_proactive_touches.sql:14 | RLS on (static); policies=1 |
| `user_capability_preferences` | 20260420110000_vtid_01942_capability_preferences.sql:20 | RLS on (static); policies=2 |
| `user_profiler_version` | 20260420120000_BOOTSTRAP_history_aware_timeline.sql:59 | RLS on (static); policies=1 |
| `tenant_kpi_current` | 20260421220000_BOOTSTRAP_admin_kpi_surface.sql:22 | RLS on (static); policies=2 |
| `tenant_kpi_daily` | 20260421220000_BOOTSTRAP_admin_kpi_surface.sql:33 | RLS on (static); policies=2 |
| `tenant_health_index_daily` | 20260422130000_BOOTSTRAP_tenant_health_index.sql:17 | RLS on (static); policies=1 |
| `user_integrations` | 20260423200000_vitana_integrations_v1.sql:35 | RLS on (static); policies=2 |
| `user_active_days` | 20260424400000_BOOTSTRAP_dyk_user_active_days.sql:27 | RLS on (static); policies=1 |
| `voice_healing_spec_memory` | 20260425700000_vtid_01960_voice_healing_spec_memory.sql:17 | RLS on (static); policies=0 |
| `voice_architecture_reports` | 20260425900000_vtid_01963_voice_architecture_reports.sql:16 | RLS on (static); policies=0 |
| `memory_audit_log` | 20260427000000_vtid_01966_memory_audit_log.sql:22 | RLS on (static); policies=1 |
| `mem_episodes` | 20260427180000_vtid_02003_phase_5a_tier2_schema.sql:40 | RLS on (DO loop 02003); policy <table>_tenant_user_select (tenant AND user_id = auth.uid()) |
| `mem_facts` | 20260427180000_vtid_02003_phase_5a_tier2_schema.sql:84 | RLS on (DO loop 02003); policy <table>_tenant_user_select (tenant AND user_id = auth.uid()) |
| `mem_graph_edges` | 20260427180000_vtid_02003_phase_5a_tier2_schema.sql:121 | RLS on (DO loop 02003); policy <table>_tenant_user_select (tenant AND user_id = auth.uid()) |
| `mem_turn_log` | 20260427180000_vtid_02003_phase_5a_tier2_schema.sql:153 | RLS on (DO loop 02003); policy <table>_tenant_user_select (tenant AND user_id = auth.uid()) |
| `memory_write_dlq` | 20260427180000_vtid_02003_phase_5a_tier2_schema.sql:172 | RLS on (DO loop 02003); policy <table>_tenant_user_select (tenant AND user_id = auth.uid()) |
| `user_personality_profile` | 20260427180000_vtid_02003_phase_5a_tier2_schema.sql:192 | RLS on (DO loop 02003); policy <table>_tenant_user_select (tenant AND user_id = auth.uid()) |
| `mood_pattern_aggregates` | 20260427180000_vtid_02003_phase_5a_tier2_schema.sql:209 | RLS on (DO loop 02003); policy <table>_tenant_user_select (tenant AND user_id = auth.uid()) |
| `biometric_trends` | 20260427180000_vtid_02003_phase_5a_tier2_schema.sql:224 | RLS on (DO loop 02003); policy <table>_tenant_user_select (tenant AND user_id = auth.uid()) |
| `biometric_events` | 20260427180000_vtid_02003_phase_5a_tier2_schema.sql:244 | RLS on (DO loop 02003); policy <table>_tenant_user_select (tenant AND user_id = auth.uid()) |
| `user_location_settings` | 20260427180000_vtid_02003_phase_5a_tier2_schema.sql:261 | RLS on (DO loop 02003); policy <table>_tenant_user_select (tenant AND user_id = auth.uid()) |
| `user_location_history` | 20260427180000_vtid_02003_phase_5a_tier2_schema.sql:275 | RLS on (DO loop 02003); policy <table>_tenant_user_select (tenant AND user_id = auth.uid()) |
| `user_device_session_log` | 20260427180000_vtid_02003_phase_5a_tier2_schema.sql:299 | RLS on (DO loop 02003); policy <table>_tenant_user_select (tenant AND user_id = auth.uid()) |
| `relationship_dates` | 20260427180000_vtid_02003_phase_5a_tier2_schema.sql:313 | RLS on (DO loop 02003); policy <table>_tenant_user_select (tenant AND user_id = auth.uid()) |
| `relationship_health_context` | 20260427180000_vtid_02003_phase_5a_tier2_schema.sql:328 | RLS on (DO loop 02003); policy <table>_tenant_user_select (tenant AND user_id = auth.uid()) |
| `agent_third_party_connections` | 20260429120000_vtid_02047_phase5_management_schema.sql:101 | RLS on (static); policies=1 |
| `agent_personas_tenant_overrides` | 20260501150000_vtid_02652_phase6_tenant_overrides.sql:29 | RLS on (static); policies=2 |
| `agent_kb_bindings_tenant` | 20260501150000_vtid_02652_phase6_tenant_overrides.sql:53 | RLS on (static); policies=2 |
| `agent_routing_keywords_tenant` | 20260501150000_vtid_02652_phase6_tenant_overrides.sql:75 | RLS on (static); policies=2 |
| `community_search_history` | 20260510000000_vtid_02754_community_search_history.sql:14 | RLS on (static); policies=1 |
| `architecture_reports` | 20260510000100_BOOTSTRAP_architecture_investigator.sql:15 | RLS on (static); policies=1 |
| `user_intent_cover_library` | 20260513000000_VTID_02806_intent_cover_library.sql:27 | RLS on (static); policies=4 |
| `user_assistant_state` | 20260516000000_VTID_02909_user_assistant_state.sql:24 | RLS on (static); policies=1 |
| `user_capability_awareness` | 20260518000000_VTID_02920_capability_awareness.sql:77 | RLS on (static); policies=1 |
| `user_open_threads` | 20260520000000_VTID_02932_continuity_tables.sql:28 | RLS on (static); policies=1 |
| `chat_groups` | 20260525000000_VTID_03089_chat_groups.sql:12 | RLS on (static); policies=4 |
| `chat_group_members` | 20260525000000_VTID_03089_chat_groups.sql:26 | RLS on (static); policies=4 |
| `subscription_plans` | 20260526010000_VTID_03107_subscription_core.sql:42 | RLS on (static); policies=2 |
| `subscription_plan_prices` | 20260526010000_VTID_03107_subscription_core.sql:66 | RLS on (static); policies=2 |
| `user_subscriptions` | 20260526010000_VTID_03107_subscription_core.sql:90 | RLS on (static); policies=2 |
| `credit_packs` | 20260526010000_VTID_03107_subscription_core.sql:190 | RLS on (static); policies=2 |
| `lifecycle_notification_state` | 20260526080000_VTID_03107_lifecycle_notifications.sql:30 | RLS on (static); policies=2 |
| `wallet_accounts` | 20260529000000_VTID_03200_wallet_stripe_deposits.sql:88 | RLS on (static); policies=3 |
| `wallet_deposits` | 20260529000000_VTID_03200_wallet_stripe_deposits.sql:113 | RLS on (static); policies=3 |
| `wallet_ledger_entries` | 20260529000000_VTID_03200_wallet_stripe_deposits.sql:146 | RLS on (static); policies=3 |
| `user_journey_foundation` | 20260602000000_VTID_03255_journey_foundation.sql:29 | RLS on (static); policies=1 |
| `journey_session_updates` | 20260602000000_VTID_03255_journey_foundation.sql:68 | RLS on (static); policies=1 |
| `user_journey` | 20260603000000_VTID_03152_user_journey_table.sql:28 | RLS on (static); policies=2 |
| `orb_session_state` | 20260606000000_DEV_COMHU_0503_orb_session_state.sql:20 | RLS on (static); policies=1 |
| `user_guided_journey_state` | 20260608160000_VTID_03276_guided_journey_mode_state.sql:29 | RLS on (static); policies=1 |
| `journey_session_index_awards` | 20260610120000_BOOTSTRAP_journey_session_index_award.sql:24 | RLS on (static); policies=0 |
| `wallet_balance_resets` | 20260717120100_reset_all_user_wallet_balances_to_zero.sql:9 | RLS on (static); policies=2 |
| `community_listing_reports` | 20260727090000_bootstrap_community_marketplace.sql:149 | RLS on (static); policies=3 |
| `partner_health_test_orders` | 20260914090000_vtid_03885_partner_health_test_integration.sql:70 | RLS on (static); policies=1 |
| `partner_health_test_status_history` | 20260914090000_vtid_03885_partner_health_test_integration.sql:105 | RLS on (static); policies=1 |
| `partner_health_results` | 20260914090000_vtid_03885_partner_health_test_integration.sql:124 | RLS on (static); policies=1 |
| `partner_health_result_inbox` | 20260914090000_vtid_03885_partner_health_test_integration.sql:152 | RLS on (static); policies=0 |
| `dev_agent_memory` | 20260914182357_vtid_03889_dev_agent_memory.sql:28 | NO RLS statement found in any migration |
| `partner_organization_members` | 20260915120000_vtid_03932_partner_organizations.sql:64 | RLS on (static); policies=2 |
| `partner_organization_invites` | 20260915120000_vtid_03932_partner_organizations.sql:84 | RLS on (static); policies=0 |
| `patient_profiles` | 20260915120000_vtid_03932_partner_organizations.sql:106 | RLS on (static); policies=1 |
| `service_bot_accounts` | 20260917084341_vtid_03990_service_bot_accounts_skip_welcome_chat.sql:25 | RLS on (static); policies=0 |
| `operator_messages` | 20260917230000_vtid_04022_operator_threads.sql:35 | RLS on (static); policies=1 |
| `conversation_metrics_hourly` | 20260923140000_vtid_04371_conversation_metrics_hourly.sql:18 | RLS on (static); policies=1 |
| `memory_transcript_turns` | 20260923160000_vtid_04387_memory_transcript_turns.sql:13 | RLS on (static); policies=1 |
| `calendar_feed_tokens` | 20260923170000_vtid_04358_calendar_feed_tokens.sql:8 | RLS on (static); policies=0 |
| `conversation_offer_outcomes` | 20260923190000_vtid_04421_conversation_offer_outcomes.sql:13 | RLS on (static); policies=0 |
| `apple_account_credentials` | 20260923200000_vtid_04402_connected_apps.sql:50 | RLS on (static); policies=0 |
| `conversation_scoring_weights` | 20260923200000_vtid_04422_conversation_scoring_weights.sql:13 | RLS on (static); policies=0 |
| `memory_fact_forgotten` | 20260923220000_vtid_04441_memory_fact_forgotten.sql:19 | RLS on (static); policies=0 |
| `calendar_push_targets` | 20260924090000_vtid_04436_calendar_push.sql:9 | RLS on (static); policies=0 |
| `calendar_push_links` | 20260924090000_vtid_04436_calendar_push.sql:23 | RLS on (static); policies=0 |
| `notification_type_controls` | 20260926190000_vtid_04674_notification_type_controls.sql:23 | RLS on (static); policies=0 |
| `notification_type_control_audit` | 20260926190000_vtid_04674_notification_type_controls.sql:41 | RLS on (static); policies=0 |
| `notification_type_blocks` | 20260926190000_vtid_04674_notification_type_controls.sql:57 | RLS on (static); policies=0 |
| `user_explicit_preferences` | 20260928200300_vtid_04720_preference_modeling_data_layer.sql:104 | RLS on (static); policies=4 |
| `voice_session_facts` | 20261001120000_vtid_04776_voice_session_facts.sql:27 | RLS on (static); policies=0 |
| `founding_members` | 20261003100000_vtid_04859_founding_1000.sql:43 | RLS on (static); policies=1 |
| `jev_member_daily_counters` | 20261004100000_vtid_04872_jev_member_quota.sql:8 | RLS on (static); policies=0 |
| `plan_sparring_sessions` | 20261004110000_vtid_04868_plan_sparring_gate.sql:87 | RLS on (static); policies=1 |
| `onboarding_touch_ledger` | 20261005130000_vtid_04892_onboarding_coach.sql:85 | RLS on (static); policies=0 |
| `reward_shop_items` | 20261008180000_vtid_04982_rewards_shop.sql:57 | RLS on (static); policies=1 |
| `reward_shipping_fees` | 20261008180000_vtid_04982_rewards_shop.sql:79 | RLS on (static); policies=1 |
| `reward_orders` | 20261008180000_vtid_04982_rewards_shop.sql:87 | RLS on (static); policies=1 |
| `phone_verification_challenges` | 20261012180000_vtid_05095_phone_verification.sql:30 | RLS on (static); policies=0 |
| `phone_verification_sends` | 20261012180000_vtid_05095_phone_verification.sql:47 | RLS on (static); policies=0 |
| `companion_messages_ledger` | 20261012200000_vtid_05099_companion_messages.sql:59 | RLS on (static); policies=0 |
| `ai_connection_grants` | 20261013150000_vtid_05133_ai_connection_grants.sql:46 | RLS on (static); policies=2 |
| `user_enrichment_cards` | 20261013200000_vtid_05143_unified_card_system.sql:28 | RLS on (static); policies=4 |
| `reserved_tenant_slugs` | 20261014000400_vtid_05150_tenant_brand_pack.sql:129 | RLS on (static); policies=0 |
| `bak_vtid_05151_tenant_settings` | 20261014000700_vtid_05151_seed_legacy_tenant_landing.sql:34 | legacy_archive or backup table; schema USAGE revoked from PUBLIC/anon/authenticated; no RLS statement |
| `health_codes` | 20261014100100_vtid_05158_health_store.sql:61 | RLS on (static); policies=1 |
| `health_series_5m` | 20261014100100_vtid_05158_health_store.sql:106 | RLS on (static); policies=1 |
| `health_series_1h` | 20261014100100_vtid_05158_health_store.sql:127 | RLS on (static); policies=1 |
| `health_series_1d` | 20261014100100_vtid_05158_health_store.sql:148 | RLS on (static); policies=1 |
| `health_observations` | 20261014100100_vtid_05158_health_store.sql:169 | RLS on (static); policies=1 |
| `health_ingest_batches` | 20261014100100_vtid_05158_health_store.sql:195 | RLS on (static); policies=0 |
| `health_ingest_quarantine` | 20261014100100_vtid_05158_health_store.sql:221 | RLS on (static); policies=0 |
| `health_store_maintenance_runs` | 20261014100100_vtid_05158_health_store.sql:233 | RLS on (static); policies=0 |
| `health_sources` | 20261014100200_vtid_05161_health_sources.sql:49 | RLS on (static); policies=1 |
| `chat_viewing_presence` | 20261021150000_vtid_05312_chat_viewing_presence.sql:24 | RLS on (static); policies=0 |
| `tenant_content_overrides` | 20261101100000_mt_packs_tenant_content_overrides.sql:32 | RLS on (static); policies=1 |
| `tenant_pack_intake` | 20261101110000_mt_launch_tenant_pack_intake.sql:31 | RLS on (static); policies=1 |
| `tenant_content_pipeline` | 20261101110100_mt_launch_tenant_content_pipeline.sql:31 | RLS on (static); policies=1 |
| `bak_05466_memberships_20261102` | 20261102031000_vtid_05466_user_tenants_canonical.sql:57 | legacy_archive or backup table; schema USAGE revoked from PUBLIC/anon/authenticated; no RLS statement |
| `bak_05466_user_tenants_20261102` | 20261102031000_vtid_05466_user_tenants_canonical.sql:60 | legacy_archive or backup table; schema USAGE revoked from PUBLIC/anon/authenticated; no RLS statement |
| `membership_drift_reports` | 20261102031200_vtid_05466_membership_drift_report.sql:31 | RLS on (static); policies=0; dropped later: 20261102031000_vtid_05466_me |
| `tenant_claim_mismatch_log` | 20261102032100_vtid_05464_tenant_claim_mismatch_log.sql:31 | RLS on (static); policies=0; dropped later: 20261102032000_vtid_05464_ac |
| `bak_05467_user_tenants` | 20261102033000_vtid_05467_single_role_source.sql:47 | RLS on (static); policies=0; dropped later: 20261102033000_vtid_05467_ro |
| `bak_05467_user_active_roles` | 20261102033000_vtid_05467_single_role_source.sql:49 | RLS on (static); policies=0; dropped later: 20261102033000_vtid_05467_ro |
| `bak_mt_data_cleanup_memory_facts` | 20261102040100_vtid_05571_orphan_quarantine_snapshots.sql:45 | RLS on (DO loop 05571), no policy; REVOKE from anon/authenticated |
| `bak_mt_data_cleanup_memory_items` | 20261102040100_vtid_05571_orphan_quarantine_snapshots.sql:46 | RLS on (DO loop 05571), no policy; REVOKE from anon/authenticated |
| `bak_mt_data_cleanup_chat_messages` | 20261102040100_vtid_05571_orphan_quarantine_snapshots.sql:47 | RLS on (DO loop 05571), no policy; REVOKE from anon/authenticated |
| `bak_mt_data_cleanup_user_notifications` | 20261102040100_vtid_05571_orphan_quarantine_snapshots.sql:48 | RLS on (DO loop 05571), no policy; REVOKE from anon/authenticated |
| `bak_mt_data_cleanup_profiles` | 20261102042000_vtid_05572_profiles_tenant_backfill_fn.sql:44 | legacy_archive or backup table; schema USAGE revoked from PUBLIC/anon/authenticated; no RLS statement |
| `mt_profiles_tenant_backfill_log` | 20261102042000_vtid_05572_profiles_tenant_backfill_fn.sql:50 | legacy_archive or backup table; schema USAGE revoked from PUBLIC/anon/authenticated; no RLS statement |
| `mt_profiles_tenant_unresolved` | 20261102042000_vtid_05572_profiles_tenant_backfill_fn.sql:56 | legacy_archive or backup table; schema USAGE revoked from PUBLIC/anon/authenticated; no RLS statement |
| `bak_05491_content_reports` | 20261102070100_vtid_05491_mt_tenant_admin_p2_moderation.sql:56 | legacy_archive or backup table; schema USAGE revoked from PUBLIC/anon/authenticated; no RLS statement |
| `bak_vtid_05493_tenant_lifecycle` | 20261102070300_vtid_05493_mt_tenant_deactivate.sql:39 | RLS on (static); policies=0 |
| `supplier_tenant_relationships` | 20261102120000_vtid_05488_supplier_tenant_relationships.sql:48 | RLS on (static); policies=2 |
| `bak_vtid_05488_partner_tenant` | 20261102120200_vtid_05488_partner_tenant_backfill.sql:58 | RLS on (static); policies=0 |
| `bak_05595_health_home_tenant` | 20261102130100_vtid_05595_health_home_tenant_resolver_backfill.sql:91 | RLS on (static); policies=0 |
| `tenant_domains` | 20261102140000_vtid_05507_mt_tenant_domains.sql:53 | RLS on (static); policies=0 |

## Appendix C. Functions with no revoke from PUBLIC or anon (61)

These functions have no explicit REVOKE from PUBLIC or anon in any migration, and no dynamic loop covers them under the rules in "Method and limits". Run PC-1 to see their live privileges.

| # | Function | Returns | SECURITY DEFINER | Defined in | Member EXECUTE |
|---|---|---|---|---|---|
| 1 | `acquire_autopilot_run_lock` | boolean | yes | 20260116000000_vtid_01179_autopilot_event_loop.sql | no revoke found (anon and PUBLIC open by default) |
| 2 | `check_memory_access_grant` | boolean | yes | 20251231000001_vtid_01085_memory_retrieve_router.sql | no revoke found (anon and PUBLIC open by default) |
| 3 | `fn_reap_stale_live_streams` | jsonb | yes | 20260630120000_BOOTSTRAP_reap_stale_live_streams.sql | no revoke found (anon and PUBLIC open by default) |
| 4 | `get_user_balance` | decimal(15,2) | yes | 20260717120000_harden_wallet_rpc_ownership_and_rate_lookup.sql | no revoke found (anon and PUBLIC open by default) |
| 5 | `is_user_blocked` | boolean | yes | 20251231000001_vtid_01094_match_feedback_loop.sql | no revoke found (anon and PUBLIC open by default) |
| 6 | `is_user_dampened` | boolean | yes | 20251231000001_vtid_01094_match_feedback_loop.sql | no revoke found (anon and PUBLIC open by default) |
| 7 | `live_room_check_access` | boolean | yes | 20260209_vtid_01228_daily_co_live_rooms.sql | no revoke found (anon and PUBLIC open by default) |
| 8 | `live_room_revoke_access` | boolean | yes | 20260209_vtid_01228_daily_co_live_rooms.sql | no revoke found (anon and PUBLIC open by default) |
| 9 | `live_room_update_metadata` | boolean | yes | 20260209_vtid_01228_daily_co_live_rooms.sql | no revoke found (anon and PUBLIC open by default) |
| 10 | `memory_is_entity_deleted` | boolean | yes | 20251231100000_vtid_01099_memory_governance_v1.sql | no revoke found (anon and PUBLIC open by default) |
| 11 | `memory_is_entity_locked` | boolean | yes | 20251231100000_vtid_01099_memory_governance_v1.sql | no revoke found (anon and PUBLIC open by default) |
| 12 | `process_wallet_exchange` | table(transaction_id | yes | 20260717120000_harden_wallet_rpc_ownership_and_rate_lookup.sql | no revoke found (anon and PUBLIC open by default) |
| 13 | `process_wallet_exchange_and_send` | table(exchange_transaction_id | yes | 20260717120000_harden_wallet_rpc_ownership_and_rate_lookup.sql | no revoke found (anon and PUBLIC open by default) |
| 14 | `process_wallet_transfer` | table(transaction_id | yes | 20260717120000_harden_wallet_rpc_ownership_and_rate_lookup.sql | no revoke found (anon and PUBLIC open by default) |
| 15 | `recall_dev_memory` | table | yes | 20260914182357_vtid_03889_dev_agent_memory.sql | no revoke found (anon and PUBLIC open by default) |
| 16 | `recall_dev_memory_by_files` | table | yes | 20260921120000_bootstrap_dev_agent_memory_file_scope.sql | no revoke found (anon and PUBLIC open by default) |
| 17 | `release_autopilot_run_lock` | boolean | yes | 20260116000000_vtid_01179_autopilot_event_loop.sql | no revoke found (anon and PUBLIC open by default) |
| 18 | `update_user_stripe_account` | void | yes | 20260209_vtid_01231_stripe_connect.sql | no revoke found (anon and PUBLIC open by default) |
| 19 | `update_user_stripe_status` | void | yes | 20260209_vtid_01231_stripe_connect.sql | no revoke found (anon and PUBLIC open by default) |
| 20 | `validate_role_assignment` | boolean | yes | 20260913000002_vtid_03832_role_functions.sql | no revoke found (anon and PUBLIC open by default) |
| 21 | `vtid_spec_exists` | boolean | yes | 20260119000000_vtid_01190_persistent_vtid_specs.sql | no revoke found (anon and PUBLIC open by default) |
| 22 | `_memory_provenance_rank` | int | no | 20260923120000_vtid_04341_write_fact_skip_same_value.sql | no revoke found (anon and PUBLIC open by default) |
| 23 | `activity_catalog_lookup` | public.activity_catalog | no | 20261014130000_vtid_05167_activity_tiers.sql | no revoke found (anon and PUBLIC open by default) |
| 24 | `can_read_profile_field` | boolean | no | 20260507000100_account_visibility_helper_fns.sql | no revoke found (anon and PUBLIC open by default) |
| 25 | `check_canonical_fact_key` | jsonb | no | 20260416120200_vtid_02000_marketplace_helpers.sql | no revoke found (anon and PUBLIC open by default) |
| 26 | `claim_vtid_task` | jsonb | no | 20260117000000_vtid_01183_worker_agent_connector.sql | no revoke found (anon and PUBLIC open by default) |
| 27 | `community_get_matching_rules` | jsonb | no | 20251231100000_vtid_01084_community_personalization_v1.sql | no revoke found (anon and PUBLIC open by default) |
| 28 | `compute_user_lifecycle_stage` | text | no | 20260416120200_vtid_02000_marketplace_helpers.sql | no revoke found (anon and PUBLIC open by default) |
| 29 | `current_active_role` | text | no | 20251229000000_vtid_01051_me_active_role_fix.sql | no revoke found (anon and PUBLIC open by default) |
| 30 | `current_tenant` | text | no | 20251027_oasis_events_v1.sql | no revoke found (anon and PUBLIC open by default) |
| 31 | `current_user_id` | uuid | no | 20251231000000_vtid_01078_health_brain_phase_c1.sql | no revoke found (anon and PUBLIC open by default) |
| 32 | `expire_stale_vtid_claims` | integer | no | 20260117000000_vtid_01183_worker_agent_connector.sql | no revoke found (anon and PUBLIC open by default) |
| 33 | `find_similar_vtid_tasks` | table | no | 20260912120000_vtid_03819_ledger_dedup_embedding.sql | no revoke found (anon and PUBLIC open by default) |
| 34 | `fn_normalize_code` | text | no | 20260526060000_VTID_03107_redemption_codes.sql | no revoke found (anon and PUBLIC open by default) |
| 35 | `get_context_exclusion_breakdown` | table | no | 20260102000000_vtid_01117_context_window_metrics.sql | no revoke found (anon and PUBLIC open by default) |
| 36 | `get_context_window_stats` | table | no | 20260102000000_vtid_01117_context_window_metrics.sql | no revoke found (anon and PUBLIC open by default) |
| 37 | `get_pending_worker_tasks` | table | no | 20260117000000_vtid_01183_worker_agent_connector.sql | no revoke found (anon and PUBLIC open by default) |
| 38 | `get_region_group` | text | no | 20260416120000_vtid_02000_marketplace_foundation.sql | no revoke found (anon and PUBLIC open by default) |
| 39 | `get_worker_connector_stats` | jsonb | no | 20260117000000_vtid_01183_worker_agent_connector.sql | no revoke found (anon and PUBLIC open by default) |
| 40 | `identity_authorized_sources` | text[] | no | 20260426000001_vtid_01952_memory_identity_lock_trigger.sql | no revoke found (anon and PUBLIC open by default) |
| 41 | `identity_locked_fact_keys` | text[] | no | 20260426000001_vtid_01952_memory_identity_lock_trigger.sql | no revoke found (anon and PUBLIC open by default) |
| 42 | `increment_product_recommendation_click` | void | no | 20260715120000_vtid_02950_recommendation_commissions.sql | no revoke found (anon and PUBLIC open by default) |
| 43 | `increment_product_recommendation_stats` | void | no | 20260715120000_vtid_02950_recommendation_commissions.sql | no revoke found (anon and PUBLIC open by default) |
| 44 | `insert_governance_rule` | void | no | 20251120232139_oasis_gov_0108_rules_seed_fixed.sql | no revoke found (anon and PUBLIC open by default) |
| 45 | `marketplace_search_tsv` | tsvector | no | 20260416180000_vtid_02000_fix_products_v2.sql | no revoke found (anon and PUBLIC open by default) |
| 46 | `mem_episodes_semantic_search` | table | no | 20260428160000_vtid_02050_mem_episodes_semantic_search.sql | no revoke found (anon and PUBLIC open by default) |
| 47 | `memory_calculate_adjustment_delta` | int | no | 20260101000000_vtid_01116_memory_confidence_trust_engine.sql | no revoke found (anon and PUBLIC open by default) |
| 48 | `memory_compute_initial_confidence` | int | no | 20260101000000_vtid_01116_memory_confidence_trust_engine.sql | no revoke found (anon and PUBLIC open by default) |
| 49 | `memory_map_source_classification` | text | no | 20260101000000_vtid_01116_memory_confidence_trust_engine.sql | no revoke found (anon and PUBLIC open by default) |
| 50 | `memory_semantic_search` | table | no | 20260117140000_vtid_01184_pgvector_semantic_memory.sql | no revoke found (anon and PUBLIC open by default) |
| 51 | `orb_session_state_gc` | void | no | 20260606000000_DEV_COMHU_0503_orb_session_state.sql | no revoke found (anon and PUBLIC open by default) |
| 52 | `partner_org_status_for_lifecycle` | text | no | 20260924130000_vtid_04471_partner_account_model.sql | no revoke found (anon and PUBLIC open by default) |
| 53 | `partner_org_vertical_for_type` | text | no | 20260924130000_vtid_04471_partner_account_model.sql | no revoke found (anon and PUBLIC open by default) |
| 54 | `refresh_all_user_lifecycle_stages` | int | no | 20260416120200_vtid_02000_marketplace_helpers.sql | no revoke found (anon and PUBLIC open by default) |
| 55 | `release_vtid_claim` | jsonb | no | 20260117000000_vtid_01183_worker_agent_connector.sql | no revoke found (anon and PUBLIC open by default) |
| 56 | `vitana_contribution_vector_from_source_ref` | jsonb | no | 20260423150000_vitana_index_contribution_vector.sql | no revoke found (anon and PUBLIC open by default) |
| 57 | `voice_healing_dedupe_prune` | void | no | 20260425600000_vtid_01959_voice_healing_dedupe.sql | no revoke found (anon and PUBLIC open by default) |
| 58 | `voice_healing_history_prune` | void | no | 20260425800000_vtid_01962_voice_healing_sentinel.sql | no revoke found (anon and PUBLIC open by default) |
| 59 | `voice_healing_shadow_log_prune` | void | no | 20260426000000_vtid_01964_voice_healing_shadow_log.sql | no revoke found (anon and PUBLIC open by default) |
| 60 | `voice_healing_spec_memory_prune` | void | no | 20260425700000_vtid_01960_voice_healing_spec_memory.sql | no revoke found (anon and PUBLIC open by default) |
| 61 | `worker_heartbeat` | jsonb | no | 20260117000000_vtid_01183_worker_agent_connector.sql | no revoke found (anon and PUBLIC open by default) |
