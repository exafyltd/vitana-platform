-- =============================================================================
-- VTID-05023 — Baseline for the allowlist tables notification_test_actors and
-- service_bot_accounts.
-- =============================================================================
-- Records two tables that the owner states already exist on production. The
-- definitions below match the rehearsal copy, which the owner states matches
-- production. The repo was behind production; this migration brings it up to
-- what is already live.
--
-- Effect:
--   * Production: no-op. Both tables already exist, so IF NOT EXISTS skips
--     them. The owner marks this migration as already applied on production
--     before merge.
--   * Fresh database: creates both tables.
--
-- Scope: CREATE TABLE IF NOT EXISTS and ENABLE ROW LEVEL SECURITY only. No
-- ALTER that changes columns or constraints, no DROP, no data. Re-running is
-- safe.
--
-- RLS: both tables enable row level security with no policies, so only
-- service_role (which bypasses RLS) can read or write them. For
-- service_bot_accounts this matches 20260917084341_vtid_03990. For
-- notification_test_actors the RLS line is a repo decision and is NOT
-- confirmed against the live production table.
--
-- Ordering: this file sorts before 20260917084341_vtid_03990_service_bot_
-- accounts_skip_welcome_chat.sql, the first migration on the VTID-05623 branch
-- (MR !28) that refers to notification_test_actors.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.notification_test_actors (
  user_id    UUID PRIMARY KEY,
  reason     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.notification_test_actors ENABLE ROW LEVEL SECURITY;
-- No policies: service_role only. See header: this RLS line is unconfirmed
-- against the live table.

CREATE TABLE IF NOT EXISTS public.service_bot_accounts (
  user_id    UUID PRIMARY KEY,
  label      TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.service_bot_accounts ENABLE ROW LEVEL SECURITY;
-- No policies: service_role only (matches 20260917084341_vtid_03990).
