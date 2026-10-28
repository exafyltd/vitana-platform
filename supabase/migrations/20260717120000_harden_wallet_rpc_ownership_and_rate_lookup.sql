-- impact-allow-solo-migration: modifies existing SECURITY DEFINER functions
-- called directly by the frontend via supabase.rpc() — there is no gateway/
-- worker TypeScript route wrapping them, so there is no code change to pair
-- this with.
--
-- Harden legacy wallet RPCs before real-money launch.
--
-- Found during wallet-reset work: update_user_balance, process_wallet_exchange,
-- process_wallet_transfer, and process_wallet_exchange_and_send are all SECURITY DEFINER
-- and GRANTed EXECUTE to `authenticated`, but none of them verify that the caller
-- (auth.uid()) owns the account being debited/credited. Any logged-in user could call
-- these directly (e.g. via supabase-js from devtools) to fabricate balance for themselves
-- or drain another user's wallet. process_wallet_exchange(_and_send) additionally trusted
-- a client-supplied exchange rate instead of reading the server-side exchange_rates table.
--
-- This migration adds ownership checks (auth.uid() IS NULL is allowed through, since that
-- is how service_role/backend calls present -- no user JWT in that context) and makes the
-- exchange functions look up the active rate themselves.

CREATE OR REPLACE FUNCTION public.update_user_balance(
  user_id_param UUID,
  currency_param TEXT,
  amount_param DECIMAL(15,2),
  operation TEXT DEFAULT 'add'
)
RETURNS DECIMAL(15,2) AS $$
DECLARE
  new_balance DECIMAL(15,2);
  current_balance DECIMAL(15,2);
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> user_id_param THEN
    RAISE EXCEPTION 'Not authorized to modify another user''s wallet';
  END IF;

  current_balance := public.get_user_balance(user_id_param, currency_param);

  IF operation = 'add' THEN
    new_balance := current_balance + amount_param;
  ELSIF operation = 'subtract' THEN
    new_balance := current_balance - amount_param;
    IF new_balance < 0 THEN
      RAISE EXCEPTION 'Insufficient balance. Current: %, Requested: %', current_balance, amount_param;
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid operation. Use add or subtract';
  END IF;

  UPDATE public.user_wallets
  SET balance = new_balance, updated_at = NOW()
  WHERE user_id = user_id_param AND currency_type = currency_param;

  IF NOT FOUND THEN
    PERFORM public.initialize_user_wallet(user_id_param);
    UPDATE public.user_wallets
    SET balance = new_balance, updated_at = NOW()
    WHERE user_id = user_id_param AND currency_type = currency_param;
  END IF;

  RETURN new_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public';

CREATE OR REPLACE FUNCTION public.process_wallet_exchange(
  p_user_id UUID,
  p_from_currency TEXT,
  p_to_currency TEXT,
  p_amount NUMERIC,
  p_exchange_rate NUMERIC
)
RETURNS TABLE(transaction_id UUID, from_balance NUMERIC, to_balance NUMERIC) AS $$
DECLARE
  v_transaction_id UUID;
  v_exchange_fee NUMERIC;
  v_active_rate NUMERIC;
  v_converted_amount NUMERIC;
  v_net_amount NUMERIC;
  v_from_balance NUMERIC;
  v_to_balance NUMERIC;
  v_from_currency TEXT := UPPER(p_from_currency);
  v_to_currency TEXT := UPPER(p_to_currency);
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Not authorized to exchange on another user''s wallet';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Exchange amount must be positive';
  END IF;

  -- Do not trust the client-supplied rate; look up the active server-side rate.
  SELECT rate INTO v_active_rate
  FROM public.exchange_rates
  WHERE from_currency = v_from_currency AND to_currency = v_to_currency AND is_active = true
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_active_rate IS NULL THEN
    RAISE EXCEPTION 'No active exchange rate configured for % -> %', v_from_currency, v_to_currency;
  END IF;

  v_exchange_fee := 0;
  v_converted_amount := ROUND(p_amount * v_active_rate, 2);
  v_net_amount := v_converted_amount;

  PERFORM public.initialize_user_wallet(p_user_id);

  SELECT balance INTO v_from_balance FROM public.user_wallets
  WHERE user_id = p_user_id AND currency_type = v_from_currency;

  IF v_from_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance for exchange. Current: %, Required: %', v_from_balance, p_amount;
  END IF;

  UPDATE public.user_wallets
  SET balance = balance - p_amount, updated_at = NOW()
  WHERE user_id = p_user_id AND currency_type = v_from_currency;

  UPDATE public.user_wallets
  SET balance = balance + v_net_amount, updated_at = NOW()
  WHERE user_id = p_user_id AND currency_type = v_to_currency;

  SELECT balance INTO v_from_balance FROM public.user_wallets
  WHERE user_id = p_user_id AND currency_type = v_from_currency;

  SELECT balance INTO v_to_balance FROM public.user_wallets
  WHERE user_id = p_user_id AND currency_type = v_to_currency;

  INSERT INTO public.wallet_transactions (
    from_user_id, to_user_id, amount, exchange_rate, fees, status,
    transaction_type, from_currency, to_currency,
    metadata
  ) VALUES (
    p_user_id, p_user_id, p_amount, v_active_rate, v_exchange_fee, 'completed',
    'exchange', v_from_currency, v_to_currency,
    jsonb_build_object(
      'converted_amount', v_converted_amount,
      'net_amount', v_net_amount,
      'client_requested_rate', p_exchange_rate,
      'vitana_system', true,
      'processed_at', NOW()
    )
  ) RETURNING id INTO v_transaction_id;

  RETURN QUERY SELECT v_transaction_id, v_from_balance, v_to_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public';

CREATE OR REPLACE FUNCTION public.process_wallet_transfer(
  p_from_user_id UUID,
  p_to_user_id UUID,
  p_currency TEXT,
  p_amount NUMERIC
)
RETURNS TABLE(transaction_id UUID, from_balance NUMERIC, to_balance NUMERIC) AS $$
DECLARE
  v_transaction_id UUID;
  v_fee_amount NUMERIC;
  v_net_amount NUMERIC;
  v_from_balance NUMERIC;
  v_to_balance NUMERIC;
  v_currency TEXT := UPPER(p_currency);
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_from_user_id THEN
    RAISE EXCEPTION 'Not authorized to transfer from another user''s wallet';
  END IF;

  v_fee_amount := 0;
  v_net_amount := p_amount;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Transfer amount must be positive';
  END IF;

  PERFORM public.initialize_user_wallet(p_from_user_id);
  PERFORM public.initialize_user_wallet(p_to_user_id);

  SELECT balance INTO v_from_balance FROM public.user_wallets
  WHERE user_id = p_from_user_id AND currency_type = v_currency;

  IF v_from_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance. Current: %, Required: %', v_from_balance, p_amount;
  END IF;

  UPDATE public.user_wallets
  SET balance = balance - p_amount, updated_at = NOW()
  WHERE user_id = p_from_user_id AND currency_type = v_currency;

  UPDATE public.user_wallets
  SET balance = balance + v_net_amount, updated_at = NOW()
  WHERE user_id = p_to_user_id AND currency_type = v_currency;

  SELECT balance INTO v_from_balance FROM public.user_wallets
  WHERE user_id = p_from_user_id AND currency_type = v_currency;

  SELECT balance INTO v_to_balance FROM public.user_wallets
  WHERE user_id = p_to_user_id AND currency_type = v_currency;

  INSERT INTO public.wallet_transactions (
    from_user_id, to_user_id, amount, fees, status,
    transaction_type, from_currency, to_currency,
    metadata
  ) VALUES (
    p_from_user_id, p_to_user_id, p_amount, v_fee_amount, 'completed',
    'transfer', v_currency, v_currency,
    jsonb_build_object(
      'net_amount', v_net_amount,
      'vitana_system', true,
      'processed_at', NOW()
    )
  ) RETURNING id INTO v_transaction_id;

  RETURN QUERY SELECT v_transaction_id, v_from_balance, v_to_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public';

CREATE OR REPLACE FUNCTION public.process_wallet_exchange_and_send(
  p_from_user_id UUID,
  p_to_user_id UUID,
  p_from_currency TEXT,
  p_to_currency TEXT,
  p_amount NUMERIC,
  p_exchange_rate NUMERIC
)
RETURNS TABLE(exchange_transaction_id UUID, transfer_transaction_id UUID, from_balance NUMERIC, to_balance NUMERIC, net_converted_amount NUMERIC) AS $$
DECLARE
  v_exchange_transaction_id UUID;
  v_transfer_transaction_id UUID;
  v_exchange_fee NUMERIC;
  v_transfer_fee NUMERIC;
  v_active_rate NUMERIC;
  v_converted_amount NUMERIC;
  v_net_amount NUMERIC;
  v_from_balance NUMERIC;
  v_to_balance NUMERIC;
  v_from_currency TEXT := UPPER(p_from_currency);
  v_to_currency TEXT := UPPER(p_to_currency);
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_from_user_id THEN
    RAISE EXCEPTION 'Not authorized to exchange from another user''s wallet';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;

  SELECT rate INTO v_active_rate
  FROM public.exchange_rates
  WHERE from_currency = v_from_currency AND to_currency = v_to_currency AND is_active = true
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_active_rate IS NULL THEN
    RAISE EXCEPTION 'No active exchange rate configured for % -> %', v_from_currency, v_to_currency;
  END IF;

  v_exchange_fee := 0;
  v_converted_amount := ROUND(p_amount * v_active_rate, 2);
  v_transfer_fee := 0;
  v_net_amount := v_converted_amount;

  PERFORM public.initialize_user_wallet(p_from_user_id);
  PERFORM public.initialize_user_wallet(p_to_user_id);

  SELECT balance INTO v_from_balance FROM public.user_wallets
  WHERE user_id = p_from_user_id AND currency_type = v_from_currency;

  IF v_from_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance. Current: %, Required: %', v_from_balance, p_amount;
  END IF;

  UPDATE public.user_wallets
  SET balance = balance - p_amount, updated_at = NOW()
  WHERE user_id = p_from_user_id AND currency_type = v_from_currency;

  UPDATE public.user_wallets
  SET balance = balance + v_net_amount, updated_at = NOW()
  WHERE user_id = p_to_user_id AND currency_type = v_to_currency;

  SELECT balance INTO v_from_balance FROM public.user_wallets
  WHERE user_id = p_from_user_id AND currency_type = v_from_currency;

  SELECT balance INTO v_to_balance FROM public.user_wallets
  WHERE user_id = p_to_user_id AND currency_type = v_to_currency;

  INSERT INTO public.wallet_transactions (
    from_user_id, to_user_id, amount, exchange_rate, fees, status,
    transaction_type, from_currency, to_currency, metadata
  ) VALUES (
    p_from_user_id, p_from_user_id, p_amount, v_active_rate, v_exchange_fee, 'completed',
    'exchange', v_from_currency, v_to_currency,
    jsonb_build_object(
      'converted_amount', v_converted_amount,
      'net_amount', v_converted_amount,
      'client_requested_rate', p_exchange_rate,
      'vitana_system', true,
      'processed_at', NOW()
    )
  ) RETURNING id INTO v_exchange_transaction_id;

  INSERT INTO public.wallet_transactions (
    from_user_id, to_user_id, amount, fees, status,
    transaction_type, from_currency, to_currency, metadata
  ) VALUES (
    p_from_user_id, p_to_user_id, v_converted_amount, v_transfer_fee, 'completed',
    'transfer', v_to_currency, v_to_currency,
    jsonb_build_object(
      'net_amount', v_net_amount,
      'exchange_transaction_id', v_exchange_transaction_id,
      'vitana_system', true,
      'processed_at', NOW()
    )
  ) RETURNING id INTO v_transfer_transaction_id;

  RETURN QUERY SELECT
    v_exchange_transaction_id,
    v_transfer_transaction_id,
    v_from_balance,
    v_to_balance,
    v_net_amount;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public';

-- Fix real-money launch defaults: new users/currencies should start at 0, not 1000.
CREATE OR REPLACE FUNCTION public.initialize_user_wallet(user_id_param UUID)
RETURNS VOID AS $$
BEGIN
  INSERT INTO public.user_wallets (user_id, currency_type, balance)
  VALUES
    (user_id_param, 'USD', 0.00),
    (user_id_param, 'VTNA', 0.00),
    (user_id_param, 'CREDITS', 0.00)
  ON CONFLICT (user_id, currency_type) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public';

CREATE OR REPLACE FUNCTION public.get_user_balance(user_id_param UUID, currency_param TEXT)
RETURNS DECIMAL(15,2) AS $$
DECLARE
  user_balance DECIMAL(15,2);
BEGIN
  SELECT balance INTO user_balance
  FROM public.user_wallets
  WHERE user_id = user_id_param AND currency_type = currency_param;

  IF user_balance IS NULL THEN
    PERFORM public.initialize_user_wallet(user_id_param);
    RETURN 0.00;
  END IF;

  RETURN user_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public';

ALTER TABLE public.user_wallets ALTER COLUMN balance SET DEFAULT 0.00;

-- initialize_user_wallet only needs to run for a signed-in or backend-initiated user;
-- it was previously grantable to anon/PUBLIC with no reason to be.
REVOKE EXECUTE ON FUNCTION public.initialize_user_wallet(UUID) FROM PUBLIC, anon;
