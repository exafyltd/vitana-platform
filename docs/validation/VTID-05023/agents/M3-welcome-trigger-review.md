# VTID-05023 review M3: MR !28 welcome-chat trigger

- MR: !28 `Draft: VTID-05023 welcome-chat trigger skips service and test accounts`
- Source branch reviewed: `cutover/vtid-05623-welcome-trigger` at `68c8e355fb`, base `main` at `c7e17d64d9`
- Reviewer branch: `cutover/vtid-05023-M3-welcome-review` (this file only). The MR branch was not changed. Nothing was merged.
- Scope: one new migration, `supabase/migrations/20261113120000_vtid_05623_welcome_trigger_service_account_skip.sql` (+132). No other file changed.

## Verdict

CHANGES_REQUESTED. Five blockers, listed below. The skip logic itself works as the MR intends in a local check, but the MR has no test, the test account match is not shown, and two residual paths are open.

## Checks

1. **How accounts are recognised.** Two allowlist tables, checked with `EXISTS` (migration lines 29-30):
   - `public.service_bot_accounts`: a list. Its seed (`20260917084341`) has two ids, `887b34cb-…` and `856c30ed-…`.
   - `public.notification_test_actors`: a list. No migration in this repo creates or seeds it. `DATABASE_SCHEMA.md:185` says it is seeded with `a27552a3-0257-4305-8ed0-351a80fd3701` (`e2e-test@vitana.dev`). `CLAUDE.md:270-275` says the table is defined in `exafyltd/vitana-v1`.
   - No email pattern is used by this trigger. The `e2e-%@%` pattern in `DATABASE_SCHEMA.md` belongs to a different predicate, `_notif_is_test_actor`.
   - The test account id is not in the migration and not in any allowlist seed in this repo. It is matched only if a row exists at runtime in `notification_test_actors`. See F2.
2. **New file, not an edit.** Confirmed. The MR adds one file. `20261010160000_vtid_05038_…sql` is untouched. The MR is the newest welcome-function migration.
3. **Test coverage and mutation.** There is no test in the MR (F1). I ran a local check instead. Output is below.
4. **Idempotent.** Confirmed by reading. The only DDL is `CREATE OR REPLACE FUNCTION`. No table, trigger, or data change. The skip path issues an `UPDATE` that repeats safely. I did not re-apply the file twice.

Not verified: rehearsal and production state. I did not connect to any database except a local scratch cluster, and I did not touch production, AWS, or the MR branch.

## Mutation check

No test exists in the MR, so I wrote a scratch scenario file (`docs/validation/VTID-05023/agents/M3-welcome-trigger-scenarios.sql` in this branch). It uses stand-in tables with only the columns the trigger touches. It ran on a local PostgreSQL 16.2 cluster from the `pgserver` wheel, in `/projects/sandbox/agents/M3-scratch`. The mutant replaces migration lines 29-30 with `IF FALSE THEN`, and nothing else.

Variant 1, MR migration as written:
```
 case                       | account                              | msgs_sent | group_rows | welcome_flag
 A service bot              | 887b34cb-9ee9-47dc-ad53-db5be1869846 |         0 |          0 | t
 B test acct (registered)   | a27552a3-0257-4305-8ed0-351a80fd3701 |         0 |          0 | t
 C test acct (unregistered) | c0000000-0000-0000-0000-00000000000c |         1 |          1 | t
 D real member (2nd joiner) | dddddddd-0000-0000-0000-000000000002 |         1 |          1 | t
```

Variant 2, mutant with skip removed:
```
 A service bot              | 887b34cb-9ee9-47dc-ad53-db5be1869846 |         1 |          1 | t
 B test acct (registered)   | a27552a3-0257-4305-8ed0-351a80fd3701 |         1 |          1 | t
 C test acct (unregistered) | c0000000-0000-0000-0000-00000000000c |         1 |          1 | t
 D real member (2nd joiner) | dddddddd-0000-0000-0000-000000000002 |         1 |          1 | t
```

Result: removing the skip makes cases A and B send a message and enrol. A test that asserts 0/0 for A and B would fail on the mutant, so the check discriminates. C shows that an unregistered e2e-style account is not skipped.

Variant 3, MR migration with `notification_test_actors` absent:
```
WARNING:  [welcome_chat_trigger] FAILED for user dddddddd-…0002 tenant d0000000-…00dd: 42P01 / relation "public.notification_test_actors" does not exist
 D real member (2nd joiner) | dddddddd-0000-0000-0000-000000000002 |         0 |          0 | f
```
Every case, including the real member, gets 0 messages, 0 enrolment, and no welcome flag. The error is caught by the handler at migration lines 125-130 and logged as a warning only.

## Findings

**F1. No test covers the skip.** The MR adds no test under `supabase/tests` or the gateway. Nothing fails if the skip is removed. The mutant above shows the missing check would go unnoticed. Correction: add a pgTAP test in the style of `supabase/tests/vtid_04888_rule45.test.sql`. It inserts a `service_bot_accounts` user and a `notification_test_actors` user as primary members, then asserts 0 `chat_messages` sent by each, 0 `chat_group_members` rows, and `welcome_chat_sent = true`. Add a control: a real member still receives the welcome and enrolment. Run it against the mutant, which must fail.

**F2. The test account `a27552a3-…` is not shown to be matched.** Its only link to the skip is a row in `notification_test_actors`, which this repo does not create or seed. The MR contains no query output showing that row exists on the rehearsal or production. Correction: attach read-only output to the MR, such as `SELECT user_id FROM public.notification_test_actors WHERE user_id = 'a27552a3-0257-4305-8ed0-351a80fd3701'`, from the rehearsal and from production (run by the owner). If the row is missing, the owner must register it under CLAUDE.md rule 44 before merge. This reviewer did not make that change.

**F3. A missing `notification_test_actors` table silently disables welcome and enrolment for every new member.** Migration lines 29-30 query the table with no guard, and the handler at lines 125-130 swallows the error. Variant 3 above shows the result: real members get no message and no group row. Correction: decide the failure policy explicitly. Guard the second lookup with `to_regclass('public.notification_test_actors')`, using dynamic `EXECUTE` when the table exists. If the table is absent, the function should still apply the service-bot check and continue. Also add the read-only `to_regclass` result to the MR evidence for the target database.

**F4. The gateway welcome path checks only `service_bot_accounts`.** `services/gateway/src/services/welcome-chat-service.ts:63-73` skips only service-bot accounts. `routes/auth.ts:319` calls this function on first login. The MR does not change it. Disproving guard: the `already_sent` check (line 54) stops the fan-out when `app_users.welcome_chat_sent` is true. The MR's skip branch sets that flag only if an `app_users` row exists (migration line 31). If `app_users` is created after `user_tenants` (the case the migration comment at lines 36-37 describes), the flag stays false, and the login path can fan out for a test-only account. For `a27552a3`, the seed at `supabase/seed.sql:83` creates its `app_users` row, so the flag is likely set. That is not verified. Correction: add the `notification_test_actors` lookup next to the `service_bot_accounts` check at line 63, with a test, or show read-only evidence that `app_users.welcome_chat_sent = true` for `a27552a3`.

**F5. The migration and branch use the VTID the owner said not to use.** The owner stated that `VTID-05623` is an invented number and must not be used. The file name, the header comment (lines 1-5, which also cite `docs/validation/VTID-05623`), the branch name, and the commit subject all use it. Correction: relabel the file and comments with the ledger VTID, once the owner assigns one. The MR title already uses `VTID-05023`.

## Passing checks

- Skip matches the approved intent for service accounts and for test accounts that are registered (mutation table, variant 1 rows A and B).
- Only `CREATE OR REPLACE` is used. The trigger and the 05043 `WHEN` clause are not changed.
- Migration `20261010180000` drops and recreates the trigger with a `WHEN` clause and adds a suppression helper. It does not change the body of `fire_welcome_chat_on_membership`, so the MR's function body is what runs.

## Verdict file

```json
{
  "step": "VTID-05023 M3 welcome-trigger review",
  "mr": 28,
  "reviewed_head": "68c8e355fb43dd0b961f744f42ed907c0cd14e64",
  "verdict": "CHANGES_REQUESTED",
  "findings": [
    {"id": "F1", "severity": "blocker", "file": "supabase/migrations/20261113120000_vtid_05623_welcome_trigger_service_account_skip.sql", "lines": "29-30", "summary": "No test covers the service or test account skip; removing it passes unnoticed.", "correction": "Add a pgTAP test asserting zero sends, zero enrolments and welcome flag true for both allowlisted accounts, plus a real-member control; it must fail on the mutant."},
    {"id": "F2", "severity": "blocker", "file": "supabase/migrations/20261113120000_vtid_05623_welcome_trigger_service_account_skip.sql", "lines": "30", "summary": "Test account a27552a3 is not shown to be in notification_test_actors on the target database; no row or seed exists in this repo.", "correction": "Attach read-only query output for rehearsal and production; register the account under rule 44 if the row is missing."},
    {"id": "F3", "severity": "blocker", "file": "supabase/migrations/20261113120000_vtid_05623_welcome_trigger_service_account_skip.sql", "lines": "29-30, 125-130", "summary": "If notification_test_actors is absent, the handler swallows the error and every new member loses welcome and enrolment.", "correction": "Guard the lookup with to_regclass, state the failure policy, and attach target-database to_regclass evidence."},
    {"id": "F4", "severity": "blocker", "file": "services/gateway/src/services/welcome-chat-service.ts", "lines": "63-73", "summary": "The login-time welcome path checks only service_bot_accounts, so a test-only account with welcome_chat_sent false can receive a fan-out.", "correction": "Add the notification_test_actors check beside line 63 with a test, or show welcome_chat_sent is true for a27552a3."},
    {"id": "F5", "severity": "blocker", "file": "supabase/migrations/20261113120000_vtid_05623_welcome_trigger_service_account_skip.sql", "lines": "1-5", "summary": "The migration header, file name and branch use VTID-05623, which the owner said must not be used.", "correction": "Relabel with the ledger VTID once assigned."}
  ]
}
```
