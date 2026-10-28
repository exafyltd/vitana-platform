/**
 * Autopilot Automations — Database Schema
 *
 * VTID: VTID-01250 (Autopilot Automations Engine)
 *
 * Tables:
 *   - automation_runs        — Tracks each execution of an AP-XXXX automation
 *   - wallet_transactions    — User wallet credits/debits (VTN-ready)
 *   - referrals              — Referral tracking from share → signup → activation
 *   - sharing_links          — Trackable deep links with UTM + referral attribution
 *
 * All tables are tenant-scoped with RLS.
 */

-- ============================================================================
-- 1. automation_runs — Execution history for AP-XXXX automations
-- ============================================================================
CREATE TABLE IF NOT EXISTS automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  automation_id text NOT NULL,            -- e.g. 'AP-0101', 'AP-0401'
  trigger_type text NOT NULL,             -- 'cron', 'event', 'heartbeat', 'manual'
  trigger_source text,                    -- event ID, cron name, or user_id
  status text NOT NULL DEFAULT 'running', -- 'running', 'completed', 'failed', 'skipped'
  users_affected integer DEFAULT 0,
  actions_taken integer DEFAULT 0,
  error_message text,
  metadata jsonb DEFAULT '{}',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_tenant_automation
  ON automation_runs (tenant_id, automation_id);
CREATE INDEX IF NOT EXISTS idx_automation_runs_status
  ON automation_runs (status) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_automation_runs_created
  ON automation_runs (created_at DESC);

ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on automation_runs"
  ON automation_runs FOR ALL
  USING (true) WITH CHECK (true);

-- ============================================================================
-- 2. wallet_transactions — Credits/debits for user wallet
-- ============================================================================
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  amount integer NOT NULL,                -- positive = credit, negative = debit
  type text NOT NULL,                     -- 'reward', 'purchase', 'transfer', 'vtn_convert', 'refund'
  source text,                            -- what triggered: 'AP-0708', 'manual', 'referral'
  source_event_id text,                   -- idempotency key (OASIS event ID or unique ref)
  description text,
  balance_after integer NOT NULL,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_tenant_user
  ON wallet_transactions (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_source_event
  ON wallet_transactions (source_event_id) WHERE source_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wallet_tx_created
  ON wallet_transactions (created_at DESC);
-- Idempotency: prevent duplicate credits for same event
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_tx_idempotent
  ON wallet_transactions (tenant_id, user_id, source_event_id) WHERE source_event_id IS NOT NULL;

ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
-- Users can read their own transactions
CREATE POLICY "Users read own wallet transactions"
  ON wallet_transactions FOR SELECT
  USING (auth.uid() = user_id);
-- Service role can insert/update
CREATE POLICY "Service role manage wallet transactions"
  ON wallet_transactions FOR ALL
  USING (true) WITH CHECK (true);

-- ============================================================================
-- 3. wallet_balances — Materialized balance per user (updated via trigger)
-- ============================================================================
CREATE TABLE IF NOT EXISTS wallet_balances (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  balance integer NOT NULL DEFAULT 0,
  total_earned integer NOT NULL DEFAULT 0,
  total_spent integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

ALTER TABLE wallet_balances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own wallet balance"
  ON wallet_balances FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "Service role manage wallet balances"
  ON wallet_balances FOR ALL
  USING (true) WITH CHECK (true);

-- Trigger: update balance on insert
CREATE OR REPLACE FUNCTION update_wallet_balance()
RETURNS trigger AS $$
BEGIN
  INSERT INTO wallet_balances (tenant_id, user_id, balance, total_earned, total_spent, updated_at)
  VALUES (
    NEW.tenant_id,
    NEW.user_id,
    NEW.amount,
    GREATEST(NEW.amount, 0),
    GREATEST(-NEW.amount, 0),
    now()
  )
  ON CONFLICT (tenant_id, user_id) DO UPDATE SET
    balance = wallet_balances.balance + NEW.amount,
    total_earned = wallet_balances.total_earned + GREATEST(NEW.amount, 0),
    total_spent = wallet_balances.total_spent + GREATEST(-NEW.amount, 0),
    updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_wallet_balance_update
  AFTER INSERT ON wallet_transactions
  FOR EACH ROW
  EXECUTE FUNCTION update_wallet_balance();

-- ============================================================================
-- 4. referrals — Referral chain tracking
-- ============================================================================
CREATE TABLE IF NOT EXISTS referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  referrer_id uuid NOT NULL,              -- user who shared
  referred_id uuid,                       -- user who signed up (null until signup)
  source text NOT NULL DEFAULT 'direct',  -- 'whatsapp', 'social', 'direct', 'email'
  utm_campaign text,
  utm_source text,
  utm_medium text,
  sharing_link_id uuid,                   -- FK to sharing_links
  status text NOT NULL DEFAULT 'created', -- 'created', 'clicked', 'signed_up', 'activated', 'rewarded'
  reward_amount integer,                  -- credits awarded
  click_count integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  rewarded_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_referrals_tenant_referrer
  ON referrals (tenant_id, referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred
  ON referrals (referred_id) WHERE referred_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_referrals_status
  ON referrals (status);

ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own referrals"
  ON referrals FOR SELECT
  USING (auth.uid() = referrer_id OR auth.uid() = referred_id);
CREATE POLICY "Service role manage referrals"
  ON referrals FOR ALL
  USING (true) WITH CHECK (true);

-- ============================================================================
-- 5. sharing_links — Trackable deep links with analytics
-- ============================================================================
CREATE TABLE IF NOT EXISTS sharing_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,                  -- who created the link
  target_type text NOT NULL,              -- 'event', 'group', 'profile', 'product', 'service'
  target_id uuid NOT NULL,                -- ID of the shared entity
  short_code text NOT NULL,               -- unique short code for URL
  utm_source text DEFAULT 'vitana',
  utm_medium text DEFAULT 'share',
  utm_campaign text,
  click_count integer DEFAULT 0,
  signup_count integer DEFAULT 0,
  metadata jsonb DEFAULT '{}',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sharing_links_short_code
  ON sharing_links (short_code);
CREATE INDEX IF NOT EXISTS idx_sharing_links_tenant_user
  ON sharing_links (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_sharing_links_target
  ON sharing_links (target_type, target_id);

ALTER TABLE sharing_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own sharing links"
  ON sharing_links FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "Service role manage sharing links"
  ON sharing_links FOR ALL
  USING (true) WITH CHECK (true);

-- ============================================================================
-- RPC: Credit wallet (idempotent)
-- ============================================================================
CREATE OR REPLACE FUNCTION credit_wallet(
  p_tenant_id uuid,
  p_user_id uuid,
  p_amount integer,
  p_type text,
  p_source text,
  p_source_event_id text,
  p_description text DEFAULT NULL
)
RETURNS jsonb AS $$
DECLARE
  v_current_balance integer;
  v_new_balance integer;
  v_tx_id uuid;
BEGIN
  -- Get current balance (or 0 if no record)
  SELECT COALESCE(balance, 0) INTO v_current_balance
  FROM wallet_balances
  WHERE tenant_id = p_tenant_id AND user_id = p_user_id;

  IF v_current_balance IS NULL THEN
    v_current_balance := 0;
  END IF;

  v_new_balance := v_current_balance + p_amount;

  -- Prevent negative balance for debits
  IF v_new_balance < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_BALANCE', 'balance', v_current_balance);
  END IF;

  -- Insert transaction (idempotent via unique index on source_event_id)
  INSERT INTO wallet_transactions (tenant_id, user_id, amount, type, source, source_event_id, description, balance_after)
  VALUES (p_tenant_id, p_user_id, p_amount, p_type, p_source, p_source_event_id, p_description, v_new_balance)
  ON CONFLICT (tenant_id, user_id, source_event_id) WHERE source_event_id IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_tx_id;

  IF v_tx_id IS NULL THEN
    -- Already credited (idempotent)
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'balance', v_current_balance);
  END IF;

  RETURN jsonb_build_object('ok', true, 'transaction_id', v_tx_id, 'balance', v_new_balance, 'amount', p_amount);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
