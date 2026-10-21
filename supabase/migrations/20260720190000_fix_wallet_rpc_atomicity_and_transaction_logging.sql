-- impact-allow-solo-migration: modifies existing SECURITY DEFINER functions
-- called directly by the frontend via supabase.rpc() (paired with a same-PR
-- vitana-v1 change); no gateway/worker route wraps these.
--
-- Fix the TOCTOU race condition shared by all four wallet-mutating RPCs, and
-- give update_user_balance the ability to log an immutable transaction record.
--
-- Every one of these functions previously did SELECT balance, check
-- sufficiency in application code, THEN UPDATE -- two concurrent calls (a
-- double-tap, a retried network request) could both read the same starting
-- balance and both pass the sufficiency check before either UPDATE commits,
-- corrupting the balance or allowing a double-spend. Replaced with a single
-- atomic `UPDATE ... WHERE balance >= amount RETURNING balance`: Postgres
-- evaluates the WHERE clause and applies the write as one atomic, row-locked
-- operation, so a concurrent racer either sees the row locked until this
-- transaction commits, or sees the already-updated balance -- there is no
-- window where both can succeed.
--
-- Also: update_user_balance previously never wrote a wallet_transactions
-- row at all, unlike process_wallet_exchange/transfer. Every caller (Buy
-- Credits, Buy VTNA bonus, Withdraw, Stake, Spend) now passes a
-- transaction_type so their history actually shows up for the user. Extended
-- the CHECK constraint with 'withdrawal' and 'stake' to cover the two
-- actions that don't already have a fitting existing type.

ALTER TABLE public.wallet_transactions DROP CONSTRAINT wallet_transactions_transaction_type_check;
ALTER TABLE public.wallet_transactions ADD CONSTRAINT wallet_transactions_transaction_type_check
  CHECK (transaction_type = ANY (ARRAY['transfer', 'exchange', 'reward', 'purchase', 'withdrawal', 'stake']));

CREATE OR REPLACE FUNCTION public.update_user_balance(
  user_id_param UUID,
  currency_param TEXT,
  amount_param DECIMAL(15,2),
  operation TEXT DEFAULT 'add',
  p_transaction_type TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL
)
RETURNS DECIMAL(15,2) AS $$
DECLARE
  new_balance DECIMAL(15,2);
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> user_id_param THEN
    RAISE EXCEPTION 'Not authorized to modify another user''s wallet';
  END IF;

  IF amount_param <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;

  -- Ensure the row exists (idempotent no-op if it already does).
  INSERT INTO public.user_wallets (user_id, currency_type, balance)
  VALUES (user_id_param, currency_param, 0.00)
  ON CONFLICT (user_id, currency_type) DO NOTHING;

  IF operation = 'add' THEN
    UPDATE public.user_wallets
    SET balance = balance + amount_param, updated_at = NOW()
    WHERE user_id = user_id_param AND currency_type = currency_param
    RETURNING balance INTO new_balance;
  ELSIF operation = 'subtract' THEN
    UPDATE public.user_wallets
    SET balance = balance - amount_param, updated_at = NOW()
    WHERE user_id = user_id_param AND currency_type = currency_param
      AND balance >= amount_param
    RETURNING balance INTO new_balance;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Insufficient balance for this operation';
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid operation. Use add or subtract';
  END IF;

  IF p_transaction_type IS NOT NULL THEN
    INSERT INTO public.wallet_transactions (
      from_user_id, to_user_id, amount, status, transaction_type,
      from_currency, to_currency, metadata
    ) VALUES (
      CASE WHEN operation = 'subtract' THEN user_id_param ELSE NULL END,
      CASE WHEN operation = 'add' THEN user_id_param ELSE NULL END,
      amount_param, 'completed', p_transaction_type,
      currency_param, currency_param,
      jsonb_build_object(
        'description', p_description,
        'operation', operation,
        'vitana_system', true,
        'processed_at', NOW()
      )
    );
  END IF;

  RETURN new_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public';

-- CREATE OR REPLACE only replaces a function with an EXACT signature match.
-- Adding the two new trailing parameters above created a second overload
-- instead of replacing the original -- Postgres allowed both
-- update_user_balance(uuid,text,numeric,text) and (uuid,text,numeric,text,
-- text,text) to coexist (the new one's trailing params both have defaults,
-- so it's callable with 4 args too, which is exactly the ambiguity we don't
-- want). Drop the stale 4-arg overload so only the atomic, logging-capable
-- version can ever be called.
DROP FUNCTION IF EXISTS public.update_user_balance(uuid, text, numeric, text);

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

  -- Atomic debit: the WHERE guard makes the sufficiency check and the write
  -- a single operation, closing the race the old SELECT-then-UPDATE had.
  UPDATE public.user_wallets
  SET balance = balance - p_amount, updated_at = NOW()
  WHERE user_id = p_user_id AND currency_type = v_from_currency
    AND balance >= p_amount
  RETURNING balance INTO v_from_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient balance for exchange';
  END IF;

  UPDATE public.user_wallets
  SET balance = balance + v_net_amount, updated_at = NOW()
  WHERE user_id = p_user_id AND currency_type = v_to_currency
  RETURNING balance INTO v_to_balance;

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

  UPDATE public.user_wallets
  SET balance = balance - p_amount, updated_at = NOW()
  WHERE user_id = p_from_user_id AND currency_type = v_currency
    AND balance >= p_amount
  RETURNING balance INTO v_from_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient balance for transfer';
  END IF;

  UPDATE public.user_wallets
  SET balance = balance + v_net_amount, updated_at = NOW()
  WHERE user_id = p_to_user_id AND currency_type = v_currency
  RETURNING balance INTO v_to_balance;

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

  UPDATE public.user_wallets
  SET balance = balance - p_amount, updated_at = NOW()
  WHERE user_id = p_from_user_id AND currency_type = v_from_currency
    AND balance >= p_amount
  RETURNING balance INTO v_from_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient balance for exchange';
  END IF;

  UPDATE public.user_wallets
  SET balance = balance + v_net_amount, updated_at = NOW()
  WHERE user_id = p_to_user_id AND currency_type = v_to_currency
  RETURNING balance INTO v_to_balance;

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
