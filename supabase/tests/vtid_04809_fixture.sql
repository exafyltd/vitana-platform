-- VTID-04809 test fixture: the live shape of the legacy wallet tables as read
-- from production on 2026-10-01 (columns, constraints, trigger, RLS policies,
-- table grants, update_user_balance body and its PUBLIC grant). Used by
-- scripts/ci/test-vtid-04809-vtna-ledger.sh against a throwaway local Postgres.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE TABLE public.profiles (user_id uuid PRIMARY KEY);

CREATE TABLE public.user_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  currency_type text CHECK (currency_type = ANY (ARRAY['USD','VTNA','CREDITS'])),
  balance numeric DEFAULT 0.00,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (user_id, currency_type)
);

CREATE TABLE public.wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id uuid,
  to_user_id uuid,
  transaction_type text CHECK (transaction_type = ANY (ARRAY['transfer','exchange','reward','purchase','withdrawal','stake'])),
  from_currency text,
  to_currency text,
  amount numeric,
  exchange_rate numeric,
  fees numeric DEFAULT 0.00,
  status text DEFAULT 'pending' CHECK (status = ANY (ARRAY['pending','completed','failed','cancelled'])),
  metadata jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.wallet_transactions
  ADD CONSTRAINT wallet_transactions_from_user_id_fkey FOREIGN KEY (from_user_id) REFERENCES public.profiles(user_id) NOT VALID,
  ADD CONSTRAINT wallet_transactions_to_user_id_fkey FOREIGN KEY (to_user_id) REFERENCES public.profiles(user_id) NOT VALID;

CREATE TABLE public.exchange_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_currency text, to_currency text, rate numeric, trend text,
  change_24h numeric DEFAULT 0.00, created_at timestamptz DEFAULT now(), is_active boolean DEFAULT true
);
INSERT INTO public.exchange_rates (from_currency, to_currency, rate) VALUES
  ('USD','CREDITS',100), ('CREDITS','USD',0.01), ('VTNA','CREDITS',1), ('CREDITS','VTNA',1);

CREATE OR REPLACE FUNCTION public.prevent_pending_transactions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NEW.status = 'pending' THEN NEW.status = 'processing'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prevent_pending_transactions_trigger BEFORE INSERT ON public.wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_pending_transactions();

ALTER TABLE public.user_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exchange_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can update their own wallets" ON public.user_wallets FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can view their own wallets" ON public.user_wallets FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create transactions from their account" ON public.wallet_transactions FOR INSERT WITH CHECK (auth.uid() = from_user_id);
CREATE POLICY "Users can view their own transactions" ON public.wallet_transactions FOR SELECT USING ((auth.uid() = from_user_id) OR (auth.uid() = to_user_id));
CREATE POLICY "Anyone can view active exchange rates" ON public.exchange_rates FOR SELECT USING (is_active = true);

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.user_wallets, public.wallet_transactions, public.exchange_rates TO authenticated;
GRANT SELECT, REFERENCES, TRIGGER, TRUNCATE ON public.user_wallets, public.wallet_transactions, public.exchange_rates TO anon;
GRANT ALL ON public.user_wallets, public.wallet_transactions, public.exchange_rates, public.profiles TO service_role;

-- update_user_balance exactly as live before VTID-04809 (allows 'add').
CREATE OR REPLACE FUNCTION public.update_user_balance(user_id_param uuid, currency_param text, amount_param numeric, operation text DEFAULT 'add'::text, p_transaction_type text DEFAULT NULL::text, p_description text DEFAULT NULL::text)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE new_balance DECIMAL(15,2);
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> user_id_param THEN RAISE EXCEPTION 'Not authorized to modify another user''s wallet'; END IF;
  IF amount_param <= 0 THEN RAISE EXCEPTION 'Amount must be positive'; END IF;
  INSERT INTO public.user_wallets (user_id, currency_type, balance) VALUES (user_id_param, currency_param, 0.00) ON CONFLICT (user_id, currency_type) DO NOTHING;
  IF operation = 'add' THEN
    UPDATE public.user_wallets SET balance = balance + amount_param, updated_at = NOW() WHERE user_id = user_id_param AND currency_type = currency_param RETURNING balance INTO new_balance;
  ELSE
    UPDATE public.user_wallets SET balance = balance - amount_param, updated_at = NOW() WHERE user_id = user_id_param AND currency_type = currency_param AND balance >= amount_param RETURNING balance INTO new_balance;
    IF NOT FOUND THEN RAISE EXCEPTION 'Insufficient balance for this operation'; END IF;
  END IF;
  RETURN new_balance;
END $function$;
GRANT EXECUTE ON FUNCTION public.update_user_balance(uuid, text, numeric, text, text, text) TO PUBLIC, anon, authenticated, service_role;

INSERT INTO public.profiles VALUES ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');
