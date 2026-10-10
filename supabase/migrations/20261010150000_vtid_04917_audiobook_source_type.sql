-- VTID-04917 — the audiobook daily reminder shows in the member's calendar.
--
-- When a member sets, changes or clears their audiobook reminder
-- (POST /api/v1/journey/audiobook/reminder), the gateway keeps ONE recurring
-- calendar entry in step: source_type 'audiobook', source_ref_type
-- 'audiobook_reminder', source_ref_id = the member's id, rrule FREQ=DAILY in
-- the member's time zone, reminder_offsets '{}' (the audiobook dispatcher
-- stays the only sender; the calendar never pushes for it). Clearing the
-- reminder cancels the entry.
--
-- This migration only allows the new source type (recreated with every
-- existing value kept). No backfill: no member had the reminder set when it
-- was written (read-only count, 2026-10-10: 0).
-- impact-allow-solo-migration: constraint only; the gateway writer and the app display ship in the same VTID.

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
    'health_plan', 'lab_order', 'appointment', 'live_room', 'goal_plan', 'guided_journey',
    'reminder', 'subscription', 'test_result', 'audiobook'
  ));
