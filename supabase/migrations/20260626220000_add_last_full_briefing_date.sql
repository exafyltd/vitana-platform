-- Durable once-per-real-day flag for the ORB morning briefing.
--
-- The rich morning briefing used to be gated on the most-recent
-- vtid.live.session.start telemetry ("first session of a new day"), which is
-- fragile: active users open many sessions a day and the app auto-creates
-- sessions, so any earlier same-day session flipped the temporal bucket to
-- "same-day" and the briefing was skipped — in practice it almost never fired.
--
-- This column lets the gateway record the user-tz date the full briefing was
-- last delivered. The SAFE-FAST greeting fires the rich briefing on the FIRST
-- session of a day where this date is stale, then stamps today so same-day
-- reopens fall through to the short proactive opener ("full once/day, short
-- after"). NULL = never delivered → briefing is due.
ALTER TABLE public.user_journey
  ADD COLUMN IF NOT EXISTS last_full_briefing_date date;
