-- SECURITY FIX: wallet tables were writable by ANY authenticated/anon caller.
--
-- Root cause
-- ==========
-- Six "Service role manage ..." policies were written as:
--   CREATE POLICY "Service role manage X" ON X FOR ALL USING (true) WITH CHECK (true);
-- with NO `TO service_role` clause. In Postgres, a policy with no `TO`
-- clause defaults to PUBLIC — i.e. every role, including `anon` and
-- `authenticated`. Since `service_role` already bypasses RLS entirely
-- (RLS does not apply to the Postgres role Supabase's service key maps
-- to), these policies did nothing to actually gate the service role and
-- instead granted unrestricted read/write to every other role.
--
-- Impact: any authenticated user (via the public anon key) could directly
-- UPDATE their own (or, via `wallet_ledger_entries`/`wallet_transactions`,
-- fabricate) balance rows, mark deposits `succeeded`, insert forged
-- `stripe_webhook_events`, and inflate `wallet_balances`/`wallet_transactions`
-- reward credits.
--
-- Fix: drop and recreate every affected policy scoped `TO service_role`.
-- No application code changes needed — the gateway already talks to these
-- tables exclusively via the service-role client per CLAUDE.md rule
-- "Always route DB mutations through Gateway APIs."
--
-- Affected tables (VTID-03200 wallet/deposits + VTID-01250 automations):
--   wallet_accounts, wallet_deposits, wallet_ledger_entries,
--   stripe_webhook_events, wallet_transactions, wallet_balances

-- ----------------------------------------------------------------------
-- VTID-03200: wallet_stripe_deposits.sql
-- ----------------------------------------------------------------------
DROP POLICY IF EXISTS "Service role manage wallet accounts" ON wallet_accounts;
CREATE POLICY "Service role manage wallet accounts"
  ON wallet_accounts FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role manage deposits" ON wallet_deposits;
CREATE POLICY "Service role manage deposits"
  ON wallet_deposits FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role manage ledger entries" ON wallet_ledger_entries;
CREATE POLICY "Service role manage ledger entries"
  ON wallet_ledger_entries FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role manage stripe_webhook_events" ON stripe_webhook_events;
CREATE POLICY "Service role manage stripe_webhook_events"
  ON stripe_webhook_events FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- ----------------------------------------------------------------------
-- VTID-01250: autopilot_automations_engine.sql
-- ----------------------------------------------------------------------
DROP POLICY IF EXISTS "Service role manage wallet transactions" ON wallet_transactions;
CREATE POLICY "Service role manage wallet transactions"
  ON wallet_transactions FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role manage wallet balances" ON wallet_balances;
CREATE POLICY "Service role manage wallet balances"
  ON wallet_balances FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- Same defect on the remaining non-financial "Service role manage/full
-- access" policies in the same migration — fix for consistency /
-- defense-in-depth even though impact there is lower (no money movement).
DROP POLICY IF EXISTS "Service role full access on automation_runs" ON automation_runs;
CREATE POLICY "Service role full access on automation_runs"
  ON automation_runs FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role manage referrals" ON referrals;
CREATE POLICY "Service role manage referrals"
  ON referrals FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role manage sharing links" ON sharing_links;
CREATE POLICY "Service role manage sharing links"
  ON sharing_links FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- ----------------------------------------------------------------------
-- VTID-03036: bootstrap_cache had RLS disabled entirely. It holds each
-- user's full assembled memory/personalization context payload
-- (cache_key = "{user_id}|{agent_id}|{lang}"). With RLS off, Supabase's
-- default PostgREST grants make this table world-readable and
-- world-writable via the anon key: any caller could read another user's
-- personalized context, or poison the cache to feed forged context into
-- that user's next ORB/LLM turn.
--
-- Fix: enable RLS and restrict to service_role only (this table is
-- gateway-internal infra, never touched by user-facing queries — matches
-- the original design intent stated in the table's own comment).
-- ----------------------------------------------------------------------
ALTER TABLE bootstrap_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role manage bootstrap_cache" ON bootstrap_cache;
CREATE POLICY "Service role manage bootstrap_cache"
  ON bootstrap_cache FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

REVOKE ALL ON bootstrap_cache FROM anon, authenticated;
