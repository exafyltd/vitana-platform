-- VTID-04338 — Calendar step 3: every calendar entry reminds by default.
--
-- reminders already has calendar_event_id (never set by anything: 0 of 125
-- rows). The gateway now materialises one reminders row per
-- (entry, occurrence, offset) — category defaults, or the entry's own
-- reminder_offsets — and keeps them in sync when the entry moves, is
-- cancelled or completed (services/calendar-reminders.ts). Delivery is the
-- existing reminders pipeline (tick → SSE overlay + push).
--
--   calendar_occurrence_start  start of the occurrence the reminder is for
--                              (a recurring entry has many)
--   reminder_offset_minutes    minutes before that start
--
-- The unique index is deliberately NOT partial: rows without a calendar link
-- (voice/UI reminders) have NULLs there and NULLs never collide, while
-- PostgREST's on_conflict needs a non-partial index to upsert against.

ALTER TABLE public.reminders
  ADD COLUMN IF NOT EXISTS calendar_occurrence_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_offset_minutes INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_reminders_calendar_occurrence_offset
  ON public.reminders (calendar_event_id, calendar_occurrence_start, reminder_offset_minutes);

CREATE INDEX IF NOT EXISTS idx_reminders_calendar_pending
  ON public.reminders (calendar_event_id)
  WHERE calendar_event_id IS NOT NULL AND status = 'pending';

COMMENT ON COLUMN public.reminders.calendar_occurrence_start IS
  'VTID-04338: start of the calendar occurrence this reminder is for (NULL for voice/UI reminders).';
COMMENT ON COLUMN public.reminders.reminder_offset_minutes IS
  'VTID-04338: minutes before calendar_occurrence_start this reminder fires.';
