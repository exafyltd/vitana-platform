-- VTID-03604 — ORB day-close (end-of-day counterpart to the new-day briefing).
--
-- Two durable once-per-night stamps, mirroring user_journey.last_full_briefing_date:
--
--   last_day_close_date       the spoken day-close (ORB opened late)
--   last_night_push_date      the nightly push (ORB NOT opened)
--
-- They are SEPARATE columns on purpose. The push must be skipped for a user who
-- already got the spoken close that evening, and collapsing both into one stamp
-- would make "did we already say goodnight" and "did we already push" the same
-- question — they are not, and a shared stamp means one surface silently
-- suppresses the other for reasons nobody can see later.
--
-- Both hold the LOCAL date of the evening the night belongs to (see
-- dayCloseNightKey): between 00:00 and 04:59 the calendar date has already
-- rolled, so the key is the date the evening STARTED. Without that, a user who
-- is said goodnight to at 23:50 and reopens at 00:10 gets a second goodnight —
-- the repeat-on-every-reopen failure VTID-03597 removed.

ALTER TABLE public.user_journey
  ADD COLUMN IF NOT EXISTS last_day_close_date  date,
  ADD COLUMN IF NOT EXISTS last_night_push_date date;

COMMENT ON COLUMN public.user_journey.last_day_close_date IS
  'VTID-03604: local evening date of the last SPOKEN ORB day-close. Once per night.';
COMMENT ON COLUMN public.user_journey.last_night_push_date IS
  'VTID-03604: local evening date of the last nightly goodnight PUSH. Once per night, and skipped entirely when last_day_close_date already covers that evening.';

-- Deliberately NOT back-filled. Stamping today would assert we already said
-- goodnight tonight and suppress the very first close for every existing user;
-- NULL correctly means "never closed a day with this user yet".

-- The nightly sweep selects users whose LOCAL hour is currently in the push
-- window, which means filtering on this column for a whole tenant every hour.
CREATE INDEX IF NOT EXISTS idx_user_journey_night_push
  ON public.user_journey (last_night_push_date);
