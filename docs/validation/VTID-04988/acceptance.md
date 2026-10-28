# VTID-04988 — earned VTNA is spent only on rewards

Owner decision 2026-10-08 ("rewards only"): earned VTNA (`reward_credits`, `user_wallets.earned_balance`) is spent
only by the Rewards shop and Premium conversion; paywall overage uses purchased credits.

AC-1 No feature_entitlements row allows reward_credits after the migration (16 rows changed, 8 untouched); the migration raises otherwise.
TEST: supabase/tests/vtid_04988_rewards_only.test.sql

AC-2 fn_consume_credits refuses reward_credits with BUCKET_NOT_SPENDABLE and writes nothing; purchased debits and the cash refusal are unchanged; members still cannot execute it.
TEST: services/gateway/test/vtid-04988-earned-vtna-rewards-only.test.ts

AC-3 consumeCredits never selects reward_credits — not when the config lists it and it would cover the debit, not when the caller prefers it. Mutation-checked: the old selection fails 2 tests.
TEST: services/gateway/test/vtid-04988-earned-vtna-rewards-only.test.ts

AC-4 User-visible, intended: the paywall's user_credit_balance for match posts/reveals, lab analyses and photo uploads no longer includes earned VTNA.
TEST: services/gateway/test/services/entitlement-service.test.ts

Decisions taken
- consumeCredits still reads the wallet buckets although they no longer choose the bucket, so a broken wallet_balances source keeps being logged on this path (pinned by the existing entitlement-service test).
- The VTID-04981 guard test treated `public.fn_consume_credits` as a grant to the PUBLIC role; it now inspects only the grantees after `TO`.
