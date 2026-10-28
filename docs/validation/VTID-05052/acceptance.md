# VTID-05052 — welcome-greeting health check stops counting test/service accounts as signups

VTID: VTID-05052
VALIDATION_PROFILE: gateway_backend

## Problem
`ALERT-WELCOME-GREETING-HEALTH.yml` failed on 2026-10-08 (run 37791591443): "2 new signups in
last 24h but ZERO trigger-fired greetings", which turned morning-check row 22 red. Both signups
were registered test accounts (`service_bot_accounts` + `notification_test_actors`); the welcome
trigger skipped them on purpose. `ci_welcome_greeting_health()` excluded only the welcome bot, so
a 24h window holding only test accounts always reported a false outage.

## Change
Migration `20261010170000_vtid_05052_ci_welcome_greeting_health_exclude_test_accounts.sql`
redefines the function: `signups_24h` and `unflagged_24h` also exclude both allowlists.
Everything else (keys, `greeted_senders_24h`, SECURITY DEFINER, search_path, grants) is unchanged.
No workflow change. `DATABASE_SCHEMA.md` updated.

## Acceptance criteria
AC-1: both counted fields exclude both allowlists and the welcome bot; return keys,
`greeted_senders_24h`, security and grants are unchanged; nothing else is redefined.
TEST: services/gateway/test/vtid-05052-welcome-greeting-health-test-accounts.test.ts

AC-2: on a local Postgres, the 2026-10-08 shape (two registered test accounts, no greetings)
returns `signups_24h=0, unflagged_24h=0`; a real ungreeted signup still returns 1/1; the
migration applies twice; anon cannot execute, service_role can.
TEST: docs/validation/VTID-05052/outputs/local-postgres-harness.sql (output: outputs/local-postgres-harness.txt)

AC-3 (after the migration is applied, read-only): `ALERT-WELCOME-GREETING-HEALTH.yml` dispatched
once is green, and the next MORNING-SYSTEM-HEALTH-CHECK reports row 22 PASS.
CURL: POST $SUPABASE_URL/rest/v1/rpc/ci_welcome_greeting_health (service role, read-only)
