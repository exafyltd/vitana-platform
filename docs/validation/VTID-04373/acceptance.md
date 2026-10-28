# VTID-04373 — Calendar reminders: quiet hours and text refresh

This follows the default-reminders loop (VTID-04338). It was built without owner
input, on the owner's instruction to finish the calendar plan.

## What was wrong

- Default reminders ignored the member's Do-Not-Disturb hours. For example, a
  06:30 workout reminded at 06:00, and a 07:00 lab test reminded at 06:00.
- Reminder text was written only when the row was inserted. After a rename,
  the reminder still showed the old title.

## Acceptance criteria

- **AC-1:** A default reminder that falls inside the member's quiet window
  fires one minute before the window starts instead. The window comes from
  `user_notification_preferences.dnd_*` and is evaluated in the member's
  local time; it may wrap midnight. The moved reminder never fires inside the
  window and never after the entry.
  TEST: `vtid-04373-calendar-reminder-quiet-hours.test.ts` › computeDesiredReminders with quiet hours.
- **AC-2:** The shift is correct across daylight-saving changes. On the night
  the clocks go back, the moved reminder still fires at 21:59 local.
  TEST: `vtid-04373-calendar-reminder-quiet-hours.test.ts` › quiet window › is DST-aware.
- **AC-3:** A moved reminder is dropped when another reminder for the same
  occurrence already fires within the 6 hours before it. A lab keeps its
  19:00 heads-up and does not get a second reminder at 21:59.
  TEST: `vtid-04373-calendar-reminder-quiet-hours.test.ts` › a lab keeps its 19:00 heads-up.
- **AC-4:** Reminders the member set on the entry itself (`reminder_offsets`)
  are not moved.
  TEST: `vtid-04373-calendar-reminder-quiet-hours.test.ts` › the entry’s own offsets.
- **AC-5:** A reminder on the day before the entry reads "tomorrow at HH:MM".
  Reminders on the same day keep their "in N" wording.
  TEST: `vtid-04373-calendar-reminder-quiet-hours.test.ts` › reminderText for a reminder on the day before.
- **AC-6:** When a pending reminder's text no longer matches the entry
  (renamed, emoji changed, wording changed), the text is rewritten on the
  next reconcile. Matching text is not written again.
  TEST: `vtid-04373-calendar-reminder-quiet-hours.test.ts` › reconcile: quiet hours and text refresh.
- **AC-7:** If quiet hours cannot be read, the error is logged and reminders
  keep their usual time. The tick still completes.
  TEST: `vtid-04373-calendar-reminder-quiet-hours.test.ts` › a failed quiet-hours read.
- **AC-8:** VTID-04338 behaviour does not change for members without quiet hours.
  TEST: `vtid-04338-calendar-default-reminders.test.ts` (unchanged, green).

## Live state (read-only, 2026-09-23)

`user_notification_preferences` has 15 rows, and 4 have `dnd_enabled`.
**None of those 4 has a start time and an end time**, so this change moves
**no** member's reminders today. It takes effect once a member sets a window.
The app has no setting for that yet; it is task #10, on the app side.

## OASIS

This change adds no new state transition. The reconcile loop is a background
maintenance pass: it writes and cancels reminder rows, and before this change
it emitted no events either. Per CLAUDE.md §6, a loop is not an OASIS event.

## Not changed

- `notification-service.isInDndWindow` compares against server time, not the
  member's local time. That is a pre-existing bug in a different pipeline and
  is left untouched here.
- `/events/window` still reports the entry's reminder rules, not where quiet
  hours moved a reminder.
