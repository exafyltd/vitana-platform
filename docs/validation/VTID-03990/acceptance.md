# VTID-03990 — Acceptance

## Incident

Two service/automation accounts (`claude-code-agent@exafy.io`,
`operator-autopilot@exafy.io`) were provisioned directly into `user_tenants`
on 2026-09-16 11:38:38/40 UTC. Neither matched the VTID-03089 welcome-chat
trigger's only exclusion (the hardcoded Vitana-bot user), so each account's
primary-membership insert fanned an identical intro DM out to every other
tenant member — 222 and 223 real recipients respectively, confirmed by a
direct, read-only count against production `chat_messages`.

## Acceptance Criteria

AC-1: A user_id registered in `service_bot_accounts` never triggers the
welcome-chat fan-out (TypeScript path) and is left marked
`welcome_chat_sent=true` so no retry can re-fire it.
TEST: services/gateway/test/services/welcome-chat-service.test.ts — "skips the broadcast and marks sent when the account is a registered service/automation account"

AC-2: If the `service_bot_accounts` lookup itself errors, the fan-out is
skipped (fails closed) rather than defaulting to sending.
TEST: services/gateway/test/services/welcome-chat-service.test.ts — "fails closed (skips, does not fan out) when the service_bot_accounts lookup itself errors"

AC-3: A real member not on the allowlist is unaffected — the normal
welcome-chat fan-out still runs exactly as before this change.
TEST: services/gateway/test/services/welcome-chat-service.test.ts — "proceeds to the normal fan-out for a real member not on the allowlist"

AC-4: The migration that creates `service_bot_accounts` and re-points
`fire_welcome_chat_on_membership()` (the live DB trigger, the mechanism that
actually caused the incident) is applied to production, not just committed
as a file — closing the exact VTID-03480 failure mode (migration authored,
never applied) this repo's own drift check exists to catch.
CURL: dispatched `RUN-MIGRATION.yml` (workflow_dispatch, run id 35202068003, conclusion=success) against `migration_file: supabase/migrations/20260917084341_vtid_03990_service_bot_accounts_skip_welcome_chat.sql`; verified post-apply via a read-only Supabase query — `select to_regclass('public.service_bot_accounts')` returns `service_bot_accounts` (table exists) and `pg_get_functiondef('public.fire_welcome_chat_on_membership'::regproc)` contains `service_bot_accounts` (the guard is live in the deployed function body). See commands.log.

AC-5: Both accounts that caused the 2026-09-16 incident are seeded into the
allowlist in production, not just documented as an intended seed.
CURL: read-only `select user_id, label, reason, created_at from public.service_bot_accounts` against production returns exactly 2 rows — `887b34cb-9ee9-47dc-ad53-db5be1869846` (claude-code-agent) and `856c30ed-7136-4bc5-8bfe-86a1e8ea1401` (operator-autopilot). See commands.log / outputs/service-bot-accounts-select.json.

## Not covered by this PR

The account-creation path itself (whatever inserted the two rows directly
into `user_tenants`, bypassing normal signup) was not found in either
`vitana-platform` or `vitana-v1` — no script or workflow in either repo
references these accounts. Flagged in the PR body rather than guessed at.
