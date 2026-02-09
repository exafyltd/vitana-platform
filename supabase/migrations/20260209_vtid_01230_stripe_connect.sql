-- ============================================================================
-- VTID-01230: Stripe Connect Express for Live Rooms Creators
-- ============================================================================
-- Enables creators to receive payments directly via Stripe Connect Express
-- Platform takes 10% fee, creator receives 90%

-- 1. Add Stripe Connect fields to app_users
ALTER TABLE app_users 
ADD COLUMN IF NOT EXISTS stripe_account_id TEXT UNIQUE,
ADD COLUMN IF NOT EXISTS stripe_charges_enabled BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS stripe_payouts_enabled BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS stripe_onboarded_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN app_users.stripe_account_id IS 
  'Stripe Connect Express account ID for receiving payments';
COMMENT ON COLUMN app_users.stripe_charges_enabled IS 
  'Whether the connected account can accept charges';
COMMENT ON COLUMN app_users.stripe_payouts_enabled IS 
  'Whether the connected account can receive payouts';

-- 2. Create index for Stripe account lookups
CREATE INDEX IF NOT EXISTS idx_app_users_stripe_account 
  ON app_users(stripe_account_id) WHERE stripe_account_id IS NOT NULL;

-- 3. RPC: Update user Stripe account (during onboarding)
CREATE OR REPLACE FUNCTION update_user_stripe_account(
  p_stripe_account_id TEXT
) RETURNS VOID AS $$
BEGIN
  UPDATE app_users
  SET 
    stripe_account_id = p_stripe_account_id,
    stripe_onboarded_at = COALESCE(stripe_onboarded_at, NOW())
  WHERE user_id = auth.uid();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. RPC: Update user Stripe status (from webhook)
CREATE OR REPLACE FUNCTION update_user_stripe_status(
  p_stripe_account_id TEXT,
  p_charges_enabled BOOLEAN,
  p_payouts_enabled BOOLEAN
) RETURNS VOID AS $$
BEGIN
  UPDATE app_users
  SET 
    stripe_charges_enabled = p_charges_enabled,
    stripe_payouts_enabled = p_payouts_enabled
  WHERE stripe_account_id = p_stripe_account_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. RPC: Get user Stripe status
CREATE OR REPLACE FUNCTION get_user_stripe_status()
RETURNS TABLE (
  stripe_account_id TEXT,
  stripe_charges_enabled BOOLEAN,
  stripe_payouts_enabled BOOLEAN,
  stripe_onboarded_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    u.stripe_account_id,
    u.stripe_charges_enabled,
    u.stripe_payouts_enabled,
    u.stripe_onboarded_at
  FROM app_users u
  WHERE u.user_id = auth.uid();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. RPC: Get creator Stripe account by user_id (for purchase flow)
CREATE OR REPLACE FUNCTION get_user_stripe_account(
  p_user_id UUID
) RETURNS TABLE (
  stripe_account_id TEXT,
  stripe_charges_enabled BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    u.stripe_account_id,
    u.stripe_charges_enabled
  FROM app_users u
  WHERE u.user_id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. Log completion
DO $$
BEGIN
  RAISE NOTICE 'VTID-01230: Stripe Connect Express schema created successfully';
END $$;
