# VTID-05038 — plan sparring record

- Sparring session: `a2b0361a-99c7-4014-a896-85ce7f6e70f1` (`plan_sparring_sessions`, attested tier)
- Change class: standard · Rounds: 3 · Verdict: **CONVERGED**
- Partner: `plan-sparring-partner` agent (read-only: Read/Grep/Glob), independent context, saw only the plan file and the code
- Final plan hash (sha256 of the text between the plan markers): `b92c5062d5fd0792020aef947d0bc658231c89dc391edc2310f90165061a5c62`
- **Owner approval (Gate 1):** d.stevanovic@exafy.io, 2026-10-10, in the Claude Code session: "Yes" — covering this plan, including applying this one migration to production via `RUN-MIGRATION.yml` before merge.

## Partner findings (verbatim)

### Round 1 — NOT CONVERGED
- F1 [major] The backfill SQL references `notification_test_actors` which is created by a vitana-v1 migration, not a vitana-platform migration -- the PGlite test fixture must create this table or the test will fail.
- F2 [major] The migration's pre-check (plan item 1, "RAISE EXCEPTION if the live function body no longer contains the VTID-03990 service-bot guard") would not work in a standard migration pipeline -- … would need to parse `pg_proc.prosrc`, which is fragile and version-dependent. … If kept, specify the exact `pg_proc.prosrc LIKE '%service_bot_accounts%'` check … document the expected behavior if the check fails.
- F3 [minor] The plan says the migration "aborts if the count exceeds 50" … an abort at the backfill stage rolls back the function fix too … consider raising the threshold.
- F4 [minor] … Use the existing `fetchExcludedTestServiceAccountIds()` from `excluded-test-service-accounts.ts` rather than adding a new repository function … `notification_test_actors` should also be excluded from group enrollment.
- F5 [minor] … the plan should explicitly state that the migration is a governed production write (via `RUN-MIGRATION.yml`) and note the approval sequence.

### Round 2 — NOT CONVERGED
- F1–F5 closed.
- F6 [major] The plan says the login path will "fail closed" on exclusion-list lookup failure, but specifies using `fetchExcludedTestServiceAccountIds()` which is explicitly fail-OPEN. … Use `fetchExcludedTestServiceAccountIdsStrict()` instead.
- Q1: … the plan should confirm [widening the trigger guard to `notification_test_actors`] is intentional and not just for the backfill.

### Round 3 — CONVERGED
- F6 closed. "No new blocker or major. The plan is ready for owner approval."

## Implementation note (after approval)
- The plan says re-running the migration is a no-op, and that an unexpected live body aborts it. Read literally, the pre-check would also abort a re-run, because after the first run the body is no longer the VTID-03990 shape. The pre-check therefore also accepts the migration's own body (marker `VTID-05038 (restores Alle Beisammen)`), and a re-run passes straight through. This is the most conservative reading that satisfies both statements. The PGlite check proves both cases.

## Final plan — Plan A — VOA slice 0: restore "Alle Beisammen" auto-enrollment for new members

Change class: **standard** (migration on a trigger function + data backfill, gateway service file).
Scope (repo `exafyltd/vitana-platform`):
- `supabase/migrations/<ts>_vtid_<id>_welcome_trigger_enrollment_restore.sql` (new)
- `services/gateway/src/services/community-group-enrollment.ts` (+ its repository file if a query is needed)
- `services/gateway/test/vtid-<id>-alle-beisammen-enrollment.test.ts` (new), a PGlite check script under `docs/validation/<VTID>/`
- `docs/validation/<VTID>/` (acceptance.md, commands.log, outputs/, staging-tests.json, plan-sparring.md), `DATABASE_SCHEMA.md` change-log row

<!-- plan:begin -->
## Problem (verified read-only against production, 2026-10-10)

Plan v3 §3 item 1 (`docs/plans/VITANA-ONBOARDING-ASSISTANT-PLAN.md`). The live body of
`public.fire_welcome_chat_on_membership()` (trigger `welcome_chat_on_primary_membership`, AFTER INSERT on
`user_tenants` WHEN `is_primary`) is the VTID-03990 version
(`supabase/migrations/20260917084341_vtid_03990_service_bot_accounts_skip_welcome_chat.sql`). That migration
re-created the function from the pre-Alle-Beisammen body (`20260601000000_VTID_03089_welcome_chat_db_trigger.sql`)
and so silently reverted `20260625000000_alle_beisammen_chat_group.sql`:
- system-group enrollment again sits AFTER the `v_recipient > 1000` early return and AFTER the
  `welcome_chat_sent` early return;
- the cap is again a hard-coded `< 100` instead of `chat_groups.metadata->>'cap'` (NULL = uncapped).

Effect, measured: "Alle Beisammen 🤗" (`49d56b24-…`, `metadata.cap = null`) has 231 members, 237 primary members
in tenant `2e7528b8-…`. Of the 16 primary members not in it, 4 are registered service/test accounts (correct to
exclude) and **12 are real members who joined between 2026-09-17 and 2026-10-06** — every real joiner since the
VTID-03990 migration. The login-time path (`addUserToSystemGroups`, called from `routes/auth.ts`) did not catch
them (8 of the 12 have auth sessions). "🎆 FIRST 100" is full (100) and stays capped.

Secondary gap found while checking: `addUserToSystemGroups()` has no service-bot guard, so a registered
service/automation account that logs in through that path would be enrolled into system groups — the exact
roster visibility CLAUDE.md rule 43 forbids.

## Change

1. **Migration** (one transaction, idempotent):
   - Read-only pre-check inside the migration, exact form: `SELECT prosrc FROM pg_proc WHERE oid =
     'public.fire_welcome_chat_on_membership()'::regprocedure`; `RAISE EXCEPTION` unless it contains
     `service_bot_accounts` AND `< 100` AND does not contain `metadata->>'cap'` — i.e. it is still exactly the
     VTID-03990 shape this migration was written against. If anyone has changed the function since 2026-10-10 the
     migration stops (whole transaction rolls back; `RUN-MIGRATION.yml` fails red, VTID-03174 hardening) and the
     new body gets reviewed instead of overwritten. The CI drift guard covers future migrations; this covers a
     change applied to the live database outside migrations.
   - `CREATE OR REPLACE FUNCTION public.fire_welcome_chat_on_membership()` = the live VTID-03990 body with exactly
     these changes and nothing else:
     a) system-group enrollment moved to right after the `app_users` lookup and the service-bot guard (so it runs
        before the `welcome_chat_sent` and `> 1000` early returns);
     b) per-group cap read from `metadata->>'cap'` (NULL/absent = uncapped), as in the Alle Beisammen migration;
     c) the account guard stays first and is widened from `service_bot_accounts` only to `service_bot_accounts`
        OR `notification_test_actors` (rule 43/45: a registered test account must not DM members or appear in a
        roster either): such a user is marked `welcome_chat_sent`, never enrolled, never fans out.
     The welcome DM fan-out text, recipients, metadata and `welcome_chat_sent` handling stay byte-identical.
   - **Backfill**: insert the missing primary members of each tenant into that tenant's **uncapped** system groups
     only (`metadata->>'cap' IS NULL`), excluding `service_bot_accounts` and `notification_test_actors`, the bot
     user, and anyone already a member (`ON CONFLICT DO NOTHING`). Capped groups ("FIRST 100") are not touched.
     Expected rows today: 12. A `RAISE NOTICE` reports the count; the migration aborts if the count exceeds 200
     (a guard against a wrong join pulling in an unexpected population; 237 primary members exist in total, so
     200 is never reached by honest growth before this runs). Function fix and backfill are deliberately one
     transaction: either both land or neither.
   - No trigger fires on `chat_group_members` INSERT (verified: no non-internal trigger on that table), so the
     backfill sends no notification, push or chat message. The new members simply appear in the group roster —
     which is what every other member got at signup.
2. **Login path guard**: `addUserToSystemGroups()` returns early (`skipped: excluded_account`) when the user is in
   either allowlist, using the existing strict variant `fetchExcludedTestServiceAccountIdsStrict()`
   (`services/gateway/src/lib/excluded-test-service-accounts.ts`, unions both tables, returns `{ok:false}` on a
   lookup error). On `ok:false` the login path skips enrollment for that call and logs it (fail closed; the trigger
   and the next login cover a real member); on `ok:true` it skips only when `ids.has(userId)`. The cap logic is unchanged.
3. **Drift guard test**: a Jest test parses the latest migration that defines `fire_welcome_chat_on_membership`
   and asserts: enrollment precedes both early returns, the cap is metadata-driven, the service-bot guard precedes
   enrollment, and the DM text is unchanged. Any future migration that re-creates the function from an old body
   fails CI.

## Tests
- Jest: drift guard (above); `addUserToSystemGroups` skips a service bot, still enrolls a real member, cap logic
  unchanged (existing behaviour cases).
- PGlite (CI-local, throwaway Postgres): the fixture creates `service_bot_accounts` and `notification_test_actors`
  (the latter is created by a vitana-v1 migration in the shared database; same fixture pattern as
  `supabase/tests/vtid_04878_fixture.sql`) and the VTID-03990 function body; apply the migration on a fixture with a capped and an uncapped group, a
  >1000-member tenant, a member with `welcome_chat_sent = true`, a service bot and a test actor → the real members
  are enrolled in the uncapped group, the capped group respects its cap, the bot/test accounts are not enrolled,
  the DM fan-out is unchanged; re-running the migration is a no-op; a changed function body aborts it.
- Staging (read-only, `staging-tests.json`): the existing gateway smoke plus this change's Jest suite. Nothing in
  the staging suite writes.
- Order (governed production write): PR open with migration + code → CI incl. PGlite and drift guard green →
  migration applied to production via `RUN-MIGRATION.yml` (the owner's Gate 1 "yes" on this plan is the approval
  for exactly this one migration; nothing else is written) → read-only verification → merge → staging deploy →
  STAGING-VERIFY → Gate 2. After the migration is applied: read-only SQL shows 0 real primary members missing from Alle Beisammen and the live function body
  contains the metadata cap and the early enrollment.

## Out of scope
- The English-only, hardcoded welcome DM text ("Hello! My name is …") — an existing i18n gap; noted, not changed
  here (changing what real members receive needs its own decision).
- Why the gateway login path missed 8 members who did log in — investigated only as far as needed; the trigger is
  the primary path and the backfill closes the gap.
<!-- plan:end -->

## Planner responses — round 1
- F1 [major] ACCEPTED — the PGlite fixture creates both allowlist tables; the cross-repo origin of `notification_test_actors` is stated in the plan.
- F2 [major] ACCEPTED (kept, made exact) — the pre-check is now specified (`pg_proc.prosrc` for the regprocedure; must contain `service_bot_accounts` and `< 100`, must not contain `metadata->>'cap'`). It guards a live change made outside migrations, which the CI drift guard cannot see; blocking a concurrent "valid fix" is the intended outcome (review, don't overwrite). A RAISE rolls the whole transaction back and `RUN-MIGRATION.yml` fails red (VTID-03174).
- F3 [minor] ACCEPTED — guard raised to 200; single transaction kept on purpose (both or neither), stated in the plan.
- F4 [minor] ACCEPTED — login path uses `fetchExcludedTestServiceAccountIds()` (both lists), fails closed on lookup error. The trigger guard is widened to both lists too (Q1).
- F5 [minor] ACCEPTED — the order is written out; the production migration is explicitly covered by the owner's Gate 1 approval and is the only production write.
- Q2: the drift guard selects the latest migration file (by name order, any name) whose text contains `FUNCTION public.fire_welcome_chat_on_membership`, so naming does not matter; behaviour (not text) is additionally proven by the PGlite check, which runs the real function.
- Q3: 50 was sized to "something went wrong"; now 200 (F3).

## Planner responses — round 2
- F6 [major] ACCEPTED — the login path uses `fetchExcludedTestServiceAccountIdsStrict()`; `ok:false` → skip enrollment and log (fail closed); `ok:true` → skip only listed ids. A Jest case pins the fail-closed branch.
- Q1: intentional and permanent, not only for the backfill — every future signup of a registered test account (`notification_test_actors`) is now skipped by the trigger: no welcome DM fan-out to members and no group enrollment (rule 43). One indexed lookup on a tiny table per primary-membership insert. A real member is never in that table, so real signups are unchanged.
