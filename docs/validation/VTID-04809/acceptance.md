# VTID-04809 — user_wallets.CREDITS as the canonical VTNA ledger

Phase 1 of the engagement & rewards plan (owner decisions 2026-10-01,
recorded in `docs/business-model/BUSINESS-MODEL.md` §11).

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: `credit_wallet(p_tenant_id, p_user_id, p_amount, p_type, p_source, p_source_event_id, p_description)` exists with the signature its callers use and writes to `user_wallets.CREDITS`; `reward` lands in `earned_balance`, `purchase` in the purchased part, anything else is refused; negative amounts debit that bucket and refuse an overdraw.
  TEST: services/gateway/test/vtid-04809-vtna-reward-ledger.test.ts
  TEST: supabase/tests/vtid_04809_vtna_reward_ledger.test.sql
AC-2: A reward with the same `p_source_event_id` lands once per member (row lock + unique index).
  TEST: supabase/tests/vtid_04809_vtna_reward_ledger.test.sql
AC-3: Earned VTNA cannot be spent by any non-reward debit (`CHECK earned_balance <= balance`; `update_user_balance` subtracts only from the purchased part).
  TEST: supabase/tests/vtid_04809_vtna_reward_ledger.test.sql
AC-4: Members cannot credit themselves: no direct INSERT/UPDATE/DELETE on `user_wallets`/`wallet_transactions`, no `credit_wallet`, `update_user_balance` refuses `'add'`, `anon` cannot call it. Members still read their own wallet and ledger.
  TEST: supabase/tests/vtid_04809_vtna_reward_ledger.test.sql
AC-5: The referral reward (member invite and AP-0405) and the AP-1301 welcome bonus credit earned VTNA via `credit_wallet`; both referral paths share one key so a referral pays once; a duplicate or a refused credit is never reported as a new credit.
  TEST: services/gateway/test/vtid-04809-vtna-reward-ledger.test.ts
  TEST: services/gateway/test/vtid-04508-community-invites.test.ts
  TEST: services/gateway/test/services/automation-handlers-onboarding-growth.test.ts
  TEST: services/gateway/test/services/automation-handlers-sharing-growth.test.ts
AC-6: EUR peg rows exist: 1 EUR = 100 CREDITS = 100 VTNA.
  TEST: supabase/tests/vtid_04809_vtna_reward_ledger.test.sql

## Rollout order

1. Merge the `exafyltd/vitana-v1` change (same VTID) that stops
   `BuyCreditsPopup` crediting "bonus" credits from the client.
2. Merge this PR (gateway deploys to staging).
3. Apply `supabase/migrations/20261001180000_vtid_04809_vtna_reward_ledger.sql`
   with `RUN-MIGRATION.yml` — production database, needs explicit approval.
   Until then the gateway's `credit_wallet` calls keep failing exactly as
   they do today (logged loudly), so step 2 changes nothing on its own.
4. Verify read-only: `credit_wallet` exists, `authenticated` lacks UPDATE on
   `user_wallets`, EUR rows present.

## Scope

SCOPE_ALLOWLIST:
- supabase/migrations/20261001180000_vtid_04809_vtna_reward_ledger.sql
- supabase/tests/vtid_04809_fixture.sql
- supabase/tests/vtid_04809_vtna_reward_ledger.test.sql
- scripts/ci/test-vtid-04809-vtna-ledger.sh
- services/gateway/src/services/wallet/vtna-reward-keys.ts
- services/gateway/src/services/community-autopilot/invites.ts
- services/gateway/src/services/automation-handlers/sharing-growth.ts
- services/gateway/src/services/automation-handlers/sharing-growth-repository.ts
- services/gateway/src/services/automation-handlers/onboarding-growth.ts
- services/gateway/src/services/automation-handlers/onboarding-growth-repository.ts
- services/gateway/test/**
- DATABASE_SCHEMA.md
- docs/business-model/BUSINESS-MODEL.md
- .claude/rules/backend.md
- docs/validation/VTID-04809/**
