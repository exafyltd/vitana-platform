-- impact-allow-solo-migration: defensive data migration only; the behavior
-- change (VTNA retired as a separately purchasable/stakeable asset, merged
-- into "VTNA Credits") lives in the paired vitana-v1 frontend PR. No new
-- gateway route or RPC signature change here.
--
-- VTNA/Credits merge (BOOTSTRAP-VTNA-CREDITS-MERGE): VTNA already had fixed
-- 1:1 parity with CREDITS and both are closed-loop/non-withdrawable (see
-- DATABASE_SCHEMA.md wallet section), so no schema change is required to
-- merge them. This defensively folds any stray VTNA balance into CREDITS
-- before the frontend permanently stops writing to VTNA. Verified via
-- `SELECT currency_type, sum(balance) FROM user_wallets GROUP BY
-- currency_type` immediately before writing this migration: all 212 users
-- have VTNA balance = 0.00, so this is a no-op today and a safety net only.
--
-- currency_type, exchange_rates rows, and historical wallet_transactions
-- keep the literal 'VTNA' value for audit-trail purposes — this migration
-- does not rewrite history, only live balances going forward.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT user_id, balance FROM public.user_wallets
    WHERE currency_type = 'VTNA' AND balance > 0
  LOOP
    INSERT INTO public.user_wallets (user_id, currency_type, balance)
    VALUES (r.user_id, 'CREDITS', r.balance)
    ON CONFLICT (user_id, currency_type)
    DO UPDATE SET balance = public.user_wallets.balance + EXCLUDED.balance, updated_at = NOW();

    UPDATE public.user_wallets
    SET balance = 0.00, updated_at = NOW()
    WHERE user_id = r.user_id AND currency_type = 'VTNA';
  END LOOP;
END $$;
