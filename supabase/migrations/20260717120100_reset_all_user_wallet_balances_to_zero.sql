-- impact-allow-solo-migration: one-time data backfill/reset (plus its own new
-- audit table) against a schema already read/written by existing frontend
-- code; no gateway/worker code needs to change alongside it.
--
-- One-time real-world-launch reset: zero every user's USD/EUR/Credits/VTNA balance.
-- Captures pre-reset values in an audit table before zeroing so support can answer
-- "what did I have before the reset" if ever needed.

CREATE TABLE IF NOT EXISTS public.wallet_balance_resets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  source_table TEXT NOT NULL,
  currency_type TEXT NOT NULL,
  previous_balance NUMERIC NOT NULL,
  reset_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  reason TEXT NOT NULL
);

ALTER TABLE public.wallet_balance_resets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own reset history"
ON public.wallet_balance_resets
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to reset history"
ON public.wallet_balance_resets
FOR ALL
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');

-- Archive current user_wallets balances (USD/CREDITS/VTNA), then zero them.
INSERT INTO public.wallet_balance_resets (user_id, source_table, currency_type, previous_balance, reason)
SELECT user_id, 'user_wallets', currency_type, balance, 'launch_reset_real_world_usage'
FROM public.user_wallets
WHERE balance <> 0;

UPDATE public.user_wallets
SET balance = 0.00, updated_at = NOW()
WHERE balance <> 0;

-- Archive + zero the Stripe EUR/USD wallet accounts too (defensive; expected to already be 0).
INSERT INTO public.wallet_balance_resets (user_id, source_table, currency_type, previous_balance, reason)
SELECT user_id, 'wallet_accounts', currency, balance_minor, 'launch_reset_real_world_usage'
FROM public.wallet_accounts
WHERE balance_minor <> 0;

UPDATE public.wallet_accounts
SET balance_minor = 0, updated_at = NOW()
WHERE balance_minor <> 0;
