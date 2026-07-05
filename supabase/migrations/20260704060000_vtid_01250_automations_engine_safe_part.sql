-- impact-allow-solo-migration: recovers schema that ALREADY-MERGED code
-- (services/gateway/src/services/automation-executor.ts createRun/
-- completeRun/getActiveRuns, live on main for months) already calls
-- against these exact table/column names. No app code change is needed
-- or expected — this is the missing half of a migration whose code
-- landed long ago; see file header for the full timestamp-collision story.
/**
 * Autopilot Automations — recovered schema (safe half)
 *
 * VTID: VTID-01250 (Autopilot Automations Engine)
 *
 * This migration was originally shipped as
 * 20260318000000_vtid_01250_autopilot_automations_engine.sql, but that
 * file shared its version timestamp with an unrelated migration
 * (20260318000000_fix_activate_recommendation_on_conflict.sql). Supabase's
 * migration tracker keys by that timestamp; only one of the two ever got
 * recorded/applied ("fix_activate_recommendation_on_conflict"), so this
 * schema silently never existed on the live database — every automation
 * run's audit insert has been failing (caught + console.warn'd, so it
 * never surfaced), and referrals/sharing-growth automations have had
 * nowhere to write.
 *
 * This file re-applies ONLY the collision-free half: automation_runs,
 * referrals, sharing_links. wallet_balances + credit_wallet() are
 * deliberately EXCLUDED — wallet_transactions already exists (created by
 * later, unrelated VTID-03107/03200 migrations) with an incompatible
 * schema (from_user_id/to_user_id/from_currency/to_currency — a VTN
 * currency-exchange ledger, not this automations engine's credit ledger).
 * Reconciling the wallet automations against that live schema is separate
 * follow-up work, not a same-day copy-paste.
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
-- 2. referrals — Referral chain tracking
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
-- 3. sharing_links — Trackable deep links with analytics
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
