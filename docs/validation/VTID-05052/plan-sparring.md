# VTID-05052 — plan sparring record

- Plan hash (sha256 of the text between the plan markers): `95943c516809ff90a8c8d3ac0594cc16a6c4fd39a81201e00c69467a56e642c4`
- Change class: standard. Partner: plan-sparring-partner (independent, read-only). Rounds: 2.
- Verdict: **converged** (round 1: five minor findings, all accepted; round 2: all closed, no new blocker or major).
- Owner approval: "Yes" in the Claude Code session, 2026-10-10, after the Gate 1 message. Allocated after approval.

## Final plan

# Plan — welcome-greeting health check: stop counting registered test/service accounts as signups

<!-- plan:begin -->
## Problem (verified read-only, 2026-10-10)
Morning Health Check row 22 (self-audit) failed on 2026-10-08 because
`ALERT-WELCOME-GREETING-HEALTH.yml` run 37791591443 (2026-10-08T14:20Z) failed:
"2 new signups in last 24h but ZERO trigger-fired greetings".

The two "signups" in that window were `7b445f73-…` (2026-10-07 15:42Z) and
`e3ff6aa3-…` (2026-10-08 13:49Z). Both are registered in
`service_bot_accounts` AND `notification_test_actors`. The LIVE trigger
`fire_welcome_chat_on_membership()` (read with pg_get_functiondef on
2026-10-10) skips both allowlists, marks `welcome_chat_sent=true`, no fan-out.
Note: the repo's last merged trigger migration
(`20260917084341_vtid_03990_...sql:84`) checks only `service_bot_accounts`;
the `notification_test_actors` check comes from VTID-05038, which is open PR
exafyltd/vitana-platform#3998 (another session) and already applied to the
live project. This plan does not touch the trigger, so it does not conflict
with #3998. The last real signup
(`9a115e1f-…`, 2026-10-06 19:36Z) was greeted correctly (rows in
`chat_messages` with `metadata.source='welcome_chat'`,
`trigger='db_trigger_on_membership'`).

The RPC `public.ci_welcome_greeting_health()` (last defined in
`supabase/migrations/20260804100000_vtid_03492_ci_health_rpcs_v2.sql`) counts
`signups_24h` from `app_users` excluding only the welcome bot UUID
`00000000-0000-0000-0000-000000000001`. So any 24h window whose only signups
are registered test/service accounts reports N signups, 0 greeted senders →
false alarm. It recurs every time a test account is created without a real
signup in the same 24h.

## Change
1. New migration `supabase/migrations/<ts>_vtid_<n>_ci_welcome_greeting_health_exclude_test_accounts.sql`:
   `CREATE OR REPLACE FUNCTION public.ci_welcome_greeting_health()` with the
   exact same signature, return shape (all 8 keys, same names), STABLE,
   SECURITY DEFINER, `search_path public, pg_catalog`. Only change:
   `signups_24h` and `unflagged_24h` additionally exclude
   `user_id IN (SELECT user_id FROM public.service_bot_accounts)` and
   `user_id IN (SELECT user_id FROM public.notification_test_actors)` —
   the same two allowlists the live trigger skips, and in any case
   required by CLAUDE.md rule 45 (both allowlists) — correct whichever
   trigger version is live. Migration comment notes `notification_test_actors`
   is created by vitana-v1 migration 20260805160000 (same Supabase project;
   verified present live 2026-10-10). `greeted_senders_24h`
   unchanged. Grants re-stated exactly as in the v2 migration (no widening).
   Idempotent (CREATE OR REPLACE).
2. Consumers of the RPC, none changed: `ALERT-WELCOME-GREETING-HEALTH.yml`
   (signups vs senders, unflagged), `MORNING-SYSTEM-HEALTH-CHECK.yml` row 9
   (signups_24h, unflagged_24h — benefits identically), and
   `SMOKE-WELCOME-GREETING.yml` (reads only trigger_present/enabled,
   function_present/secdef, trigger_table — unaffected). The workflow is NOT changed (its
   thresholds/logic stay; only the input count becomes correct).
3. Test `services/gateway/test/vtid-<n>-welcome-greeting-health-test-accounts.test.ts`:
   contract test on the migration text (both allowlists excluded in both
   counted fields, bot UUID still excluded, return keys unchanged, SECURITY
   DEFINER + search_path kept, no GRANT to anon/authenticated beyond v2).
3b. `DATABASE_SCHEMA.md`: add a change-log row and a one-line entry for
   `ci_welcome_greeting_health()` next to `ci_memory_health()` (rule 24).
4. Evidence dir `docs/validation/VTID-<n>/` (plan-sparring.md, acceptance.md,
   commands.log, outputs/, staging-tests.json — read-only RPC probe).
5. Apply the migration to the (single) Supabase project after merge via the
   governed `RUN-MIGRATION.yml` dispatch (or Supabase MCP apply_migration with
   the same file). This DDL replaces a read-only CI function; no data rows are
   written. Covered by this plan's approval.
6. Verify: call the RPC read-only → for the 2026-10-08 situation the result
   would have been signups_24h=0; dispatch `ALERT-WELCOME-GREETING-HEALTH.yml`
   once → green; next morning check row 22 green.

## Not in scope (stated so it is not mistaken for an omission)
- `ALERT-APP-USERS-IDENTITY-DRIFT.yml` (the other row-22 input). Verified
  2026-10-10: it failed 10-08/10-09 on a real gap (Supabase 237/238 vs Aurora
  233). The owner's DMS task `vitana-fullload-final-catchup` finished
  2026-10-09 22:05Z; both tables are now 238 rows with identical user_id
  sets (md5 match). It is expected green at its next run. No code change: the
  check measures a real gap correctly and must not be loosened. It will drift
  again only if CDC stays down; that is the cutover workstream, not this plan.

## Change class
standard (migration). Files: 1 migration, 1 test, DATABASE_SCHEMA.md, evidence docs.

## Risk
- Return shape unchanged → workflow parsing unchanged.
- If a real member is ever wrongly in an allowlist, they'd be hidden from this
  check — but the trigger already skips them identically, so the check now
  matches the trigger's own contract rather than diverging from it.
<!-- plan:end -->

## Planner responses — round 1
- F1 [minor] ACCEPTED (text corrected). The repo's merged trigger checks only service_bot_accounts; the LIVE trigger (pg_get_functiondef, 2026-10-10) checks both, via VTID-05038 (open PR #3998, applied live). RPC excludes both per rule 45 either way.
- F2 [minor] ACCEPTED. VTID-05038 = exafyltd/vitana-platform#3998, open, another session; reference now explains that.
- F3 [minor] ACCEPTED. Morning check row 9 named as a consumer; no workflow change.
- F4 [minor] ACCEPTED. DATABASE_SCHEMA.md change-log row + entry added to scope.
- F5 [minor] ACCEPTED (verified). SMOKE-WELCOME-GREETING.yml lines ~72-81 read only the structural keys; unaffected.
- Q3: notification_test_actors confirmed present live (query on 2026-10-10 returned both test accounts in it); cross-repo origin noted in the migration comment.

## Round 1 — partner findings (verbatim)

**F1 [minor] The plan claims the trigger skips "both allowlists" -- it only skips `service_bot_accounts`.**

Evidence: `/home/user/vitana-platform/supabase/migrations/20260917084341_vtid_03990_service_bot_accounts_skip_welcome_chat.sql:84` -- `IF EXISTS (SELECT 1 FROM public.service_bot_accounts WHERE user_id = v_user_id)`. There is no `notification_test_actors` check anywhere in `fire_welcome_chat_on_membership()`. The plan (line 13) says "VTID-03990 + VTID-05038: marks `welcome_chat_sent=true`, no fan-out" and line 34 says "the same two allowlists the trigger itself skips." The trigger only skips one.

Suggestion: Correct the plan text to say the trigger checks `service_bot_accounts` only, and that the RPC should additionally exclude `notification_test_actors` for defense-in-depth per CLAUDE.md rule 45 (not because the trigger itself uses it). This is factually wrong but does not change the solution -- excluding both in the RPC is the right call regardless. If VTID-05038 is supposed to have added `notification_test_actors` to the trigger, note that no such migration exists in the repo.

**F2 [minor] VTID-05038 is referenced but does not exist in the migrations directory.**

Evidence: `Grep` for `05038` in `/home/user/vitana-platform/supabase/migrations` returned no files. The plan (line 13) cites it as part of the trigger's skip logic.

Suggestion: Drop the VTID-05038 reference or replace it with the actual VTID that is relevant. If it is a planned-but-not-yet-shipped VTID, say so explicitly.

**F3 [minor] The `MORNING-SYSTEM-HEALTH-CHECK.yml` is a second consumer of this RPC that the plan does not mention.**

Evidence: `/home/user/vitana-platform/.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml:184` calls `ci_welcome_greeting_health`, and lines 226-234 use `signups_24h` and `unflagged_24h` for row 9 (behavioral). The plan's "Not in scope" section mentions row 22 but does not name row 9 of the morning check.

Suggestion: Mention in the plan that `MORNING-SYSTEM-HEALTH-CHECK.yml` is also a consumer and benefits from the same RPC fix (no workflow change needed). This is not a blocker since the fix is in the RPC, not the workflow.

**F4 [minor] Plan does not mention `DATABASE_SCHEMA.md` update.**

Evidence: CLAUDE.md Always rule 24: "Always update `DATABASE_SCHEMA.md` when schema changes." The plan replaces a function, which is arguably a schema change.

Suggestion: Either add a step to update `DATABASE_SCHEMA.md` or state explicitly that a function body replacement with the same signature does not constitute a schema change requiring a doc update.

**F5 [minor] `SMOKE-WELCOME-GREETING.yml` is a third consumer of the RPC.**

Evidence: `/home/user/vitana-platform/.github/workflows/SMOKE-WELCOME-GREETING.yml:60` calls `ci_welcome_greeting_health`. The smoke test logic may differ from the alert, but it reads the same fields.

Suggestion: Verify the smoke workflow's assertions still hold with the new exclusion counts. Since it is a structural/synthetic test (per its own comment on line 16), the count fields may not be relevant to its pass/fail logic, but the plan should confirm this.

Questions: (1) What is VTID-05038? (2) Is excluding `notification_test_actors` intentional defense-in-depth (rule 45)? (3) Has the planner confirmed `notification_test_actors` exists live (created by vitana-v1 migration 20260805160000)?

Verdict: CONVERGED -- no blocker or major finding.

## Round 2 — partner disposition (verbatim)

- F1 [minor] -- **closed**. Plan now correctly distinguishes the merged trigger (checks `service_bot_accounts` only) from the live trigger (checks both, via VTID-05038/PR #3998 applied but not yet merged). Justification for excluding both in the RPC is now grounded in rule 45 as the primary reason, with trigger-parity as secondary. Accurate.
- F2 [minor] -- **closed**. VTID-05038 explained as open PR #3998 in another session, already applied to live. The reference is now clear.
- F3 [minor] -- **closed**. `MORNING-SYSTEM-HEALTH-CHECK.yml` row 9 is now named as a consumer in the plan.
- F4 [minor] -- **closed**. `DATABASE_SCHEMA.md` update added to scope and to the file list.
- F5 [minor] -- **closed**. `SMOKE-WELCOME-GREETING.yml` verified to read only structural keys; noted as unaffected.

No new blocker or major findings. Verdict: CONVERGED -- all five round-1 findings are closed.
