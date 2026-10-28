# VTID-04981 — fn_consume_credits: only the gateway may call it

Security fix. `fn_consume_credits` (VTID-03107) is SECURITY DEFINER, takes any `p_user_id`, never checks
`auth.uid()`, and was granted to `authenticated`: any signed-in member could debit another member's earned
VTNA or purchased credits via `POST /rest/v1/rpc/fn_consume_credits`. Read-only check 2026-10-08: never used
(0 `paywall:%` debits, 0 negative reward rows). The only caller is the gateway (service role).

AC-1 Members (authenticated, anon, PUBLIC) cannot execute fn_consume_credits; a member call is refused by Postgres; the migration raises if that is not true after apply. Mutation-checked: without the REVOKE the migration refuses to apply.
TEST: services/gateway/test/vtid-04981-consume-credits-lockdown.test.ts

AC-2 The gateway (service_role) keeps EXECUTE and the function behaves as before (purchased_credits debit works, cash_balance still refused); the body is not redefined.
TEST: supabase/tests/vtid_04981_consume_credits_lockdown.test.sql

AC-3 Any later migration that grants fn_consume_credits to authenticated/anon/PUBLIC fails CI.
TEST: services/gateway/test/vtid-04981-consume-credits-lockdown.test.ts

AC-4 After RUN-MIGRATION on production: has_function_privilege('authenticated', …) = false and ('service_role', …) = true (read-only query, recorded in commands.log).
TEST: scripts/ci/test-vtid-04981-consume-credits-lockdown.sh

Out of scope (owner decided 2026-10-08 "rewards only"; separate plan): paywall overage spending earned VTNA.
