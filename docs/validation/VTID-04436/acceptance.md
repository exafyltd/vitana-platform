# VTID-04436 — Vitanaland entries in the member's Outlook and iPhone calendars

Before this change, the Outlook Calendar and Apple Calendar (iCloud) switches
could only read. They pulled busy times into Vitanaland, but nothing from
Vitanaland showed up in Outlook or in the iPhone Calendar app. Google Calendar
already had a two-way sync (VTID-04372). This change adds the same for the
other two.

## What was built

- **`services/connected-apps/calendar-push.ts`**:
  - For each provider, the push creates one calendar named "Vitanaland" in the
    member's account and writes their own community and personal entries into
    it. It writes to no other calendar.
  - Each entry gets a link row with a hash of what was sent. A sync writes only
    entries that are new, changed or deleted.
  - Pushed events carry no reminders. Vitanaland already sends reminders, so the
    phone would otherwise buzz twice.
- **Outlook** uses Microsoft Graph with `Calendars.ReadWrite`, which the switch
  already asks for.
  - A single entry is written in UTC.
  - A repeating entry is written in its own time zone with a Graph
    `patternedRecurrence`, so a 07:30 habit stays at 07:30 across a DST change.
  - Every rule shape the app writes is covered: DAILY, WEEKLY with BYDAY, and
    MONTHLY, each with INTERVAL, COUNT or UNTIL.
  - If a calendar named "Vitanaland" already exists, it is reused.
- **iCloud** uses CalDAV.
  - `MKCALENDAR <calendar-home>/vitanaland/` runs once; a 405 means the calendar
    exists and it is reused.
  - Then one `PUT …/vitanaland-<entry>.ics` per entry, and `DELETE` when an entry
    is removed.
  - A repeating entry keeps its RRULE unchanged, with its local start time under
    a `TZID`.
  - `apple-dav.ts` gains `davWrite` (MKCALENDAR/PUT/DELETE). The module header
    now says that writes go only to that one calendar.
- **The busy pull skips what was pushed.** Without this, every pushed entry
  would come back as a grey busy block on top of itself.
  - `listOutlookBusy` drops events whose id, or series master id, is a pushed
    event.
  - `listAppleEvents` skips the Vitanaland collection.
- **Hub**:
  - The `outlook-calendar` and `apple-calendar` syncs push first, then pull.
  - `last_result` now also reports created, updated and deleted counts.
  - Turning either app off forgets the push state. The Vitanaland calendar stays
    in the member's account for them to keep or delete, the same as Google.
- **If the member deletes the Vitanaland calendar**, the sync reports
  `vitanaland_calendar_missing` and clears the stored id. The next sync creates
  the calendar again.
- **Kill switch:** `CONNECTED_APPS_CALENDAR_PUSH=false` makes both apps pull-only
  again.
- **Migration** `20260924090000_vtid_04436_calendar_push.sql` adds two tables:
  - `calendar_push_targets` and `calendar_push_links`.
  - Both are service-role only.
  - It was applied to the project before merge, so the drift check passes.

## Acceptance criteria

AC-1: An Outlook entry is written in UTC, with no reminder of its own and shown as busy. A repeating entry keeps its zone and its wall-clock time.
TEST: test/vtid-04436-calendar-push.test.ts › Outlook mapping

AC-2: Every repeat rule the app writes maps to a Graph recurrence. A rule it cannot express is not pushed.
TEST: test/vtid-04436-calendar-push.test.ts › Outlook mapping › covers every rule shape the app writes

AC-3: An iCloud entry is a valid VEVENT with a stable UID, escaped text and folded lines. The hash ignores DTSTAMP, so an unchanged entry is not rewritten.
TEST: test/vtid-04436-calendar-push.test.ts › iCloud mapping

AC-4: The plan creates new entries and updates changed ones. It leaves unchanged entries alone. It deletes the remote copy of entries that were deleted, cancelled or never meant to be pushed (admin lens).
TEST: test/vtid-04436-calendar-push.test.ts › planExternalPush

AC-5: Outlook creates the Vitanaland calendar once and writes only into it. An existing one is reused. A deleted calendar is reported and recreated on the next sync. A delete that meets a 404 is fine.
TEST: test/vtid-04436-calendar-push.test.ts › writers

AC-6: iCloud runs MKCALENDAR under the calendar home, then PUTs one .ics per entry. A 405 reuses the calendar. A revoked password surfaces as AppleAuthError.
TEST: test/vtid-04436-calendar-push.test.ts › writers

AC-7: Neither pull turns pushed entries into busy blocks.
TEST: test/vtid-04436-calendar-push.test.ts › busy pull skips the Vitanaland calendar

AC-8: The hub pushes before it pulls. Turning the app off forgets the push state. The kill switch works.
TEST: test/vtid-04436-calendar-push.test.ts › wiring
TEST: test/vtid-04402-connected-apps.test.ts › toggle flows › Outlook calendar sync writes busy times only (no titles) and records the result

AC-9: The two tables are service-role only, with one link per provider per entry.
TEST: test/vtid-04436-calendar-push.test.ts › migration

OASIS_PROOF: no new OASIS event types. A failed push fails the app's sync, which emits the existing `connected_app.sync_failed` event (hub.ts `syncApp`, covered in test/vtid-04402-connected-apps.test.ts).

## Not verified

- **No real Outlook or iCloud account was written to.** The Microsoft OAuth
  client is not registered yet, and no Apple test account exists. Every write
  in this PR was run against scripted Graph, CalDAV and PostgREST.
- **Two specific points are not checked against the live services:**
  - Whether Graph accepts an IANA zone name (`Europe/Berlin`) in `timeZone` and
    `recurrenceTimeZone` for repeating events. Single events use UTC and are not
    affected.
  - Whether iCloud resolves a `TZID` that has no `VTIMEZONE` block.
- **The first real check** is a member with Outlook or iCloud turned on seeing
  the Vitanaland calendar appear on the phone.
