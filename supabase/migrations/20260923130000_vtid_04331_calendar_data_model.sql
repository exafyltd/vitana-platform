-- VTID-04331 — Calendar step 2: the data model the redesigned calendar needs.
--
-- calendar_events already carries the source link (source_type,
-- source_ref_id, source_ref_type + a unique index), completion tracking,
-- role_context and pillar. What it could not express:
--
--   rrule             recurrence. is_recurring / recurring_pattern exist but
--                     nothing expands them and 0 rows use them (checked
--                     2026-09-23). RFC 5545 RRULE body without DTSTART
--                     ("FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261231T235959Z");
--                     start_time is DTSTART, end_time - start_time the
--                     duration of every occurrence. Expanded at read time by
--                     the gateway (services/calendar-recurrence.ts).
--   timezone          IANA zone the rule is expanded in, so a 07:30 habit
--                     stays at 07:30 local across DST. NULL = the user's zone.
--   reminder_offsets  minutes before start at which to remind. NULL = the
--                     category default (step 3), '{}' = no reminders.
--   emoji             the entry's emoji; NULL = the category default.
--
-- role_context gains 'professional' so the professional lens is its own view
-- instead of borrowing community's. source_type gains the producers step 5
-- connects (health plans, lab orders, appointments, live rooms, goal plans,
-- guided journey). Both CHECKs only widen; every existing row stays valid.

ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS rrule TEXT,
  ADD COLUMN IF NOT EXISTS timezone TEXT,
  ADD COLUMN IF NOT EXISTS reminder_offsets INTEGER[],
  ADD COLUMN IF NOT EXISTS emoji TEXT;

ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS valid_rrule;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_rrule
  CHECK (rrule IS NULL OR rrule ~ '^FREQ=(DAILY|WEEKLY|MONTHLY)(;(INTERVAL=[1-9][0-9]*|COUNT=[1-9][0-9]*|UNTIL=[0-9]{8}T[0-9]{6}Z|BYDAY=(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU))*))*$');

ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS valid_reminder_offsets;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_reminder_offsets
  CHECK (reminder_offsets IS NULL OR (
    cardinality(reminder_offsets) <= 5
    AND 0 <= ALL (reminder_offsets)
    AND 40320 >= ALL (reminder_offsets)   -- at most 4 weeks before
  ));

ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS valid_emoji;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_emoji
  CHECK (emoji IS NULL OR char_length(emoji) BETWEEN 1 AND 16);

-- Widen role_context: + professional.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.calendar_events'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%role_context%'
  LOOP
    EXECUTE format('ALTER TABLE public.calendar_events DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_role_context
  CHECK (role_context IN ('community', 'professional', 'admin', 'developer', 'personal'));

-- Widen source_type: + the producers connected in step 5.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.calendar_events'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%source_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.calendar_events DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_source_type
  CHECK (source_type IN (
    'manual', 'invite', 'imported', 'autopilot', 'community_rsvp', 'assistant',
    'journey', 'vtid', 'ci_cd', 'nudge_engine',
    'health_plan', 'lab_order', 'appointment', 'live_room', 'goal_plan', 'guided_journey'
  ));

-- Recurring rows are read by window, not by start_time alone.
CREATE INDEX IF NOT EXISTS idx_calendar_events_recurring
  ON public.calendar_events (user_id)
  WHERE rrule IS NOT NULL AND status <> 'cancelled';

COMMENT ON COLUMN public.calendar_events.rrule IS
  'VTID-04331: RFC 5545 RRULE body (FREQ/INTERVAL/COUNT/UNTIL/BYDAY), no DTSTART; start_time is DTSTART. Expanded by the gateway.';
COMMENT ON COLUMN public.calendar_events.timezone IS
  'VTID-04331: IANA zone the rrule is expanded in; NULL = the user''s zone.';
COMMENT ON COLUMN public.calendar_events.reminder_offsets IS
  'VTID-04331: minutes before start to remind. NULL = category default, {} = none.';
COMMENT ON COLUMN public.calendar_events.emoji IS
  'VTID-04331: display emoji; NULL = category default.';
