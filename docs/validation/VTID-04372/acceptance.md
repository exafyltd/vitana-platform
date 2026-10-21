# VTID-04372 — Calendar step 7b: Google Calendar two-way sync (built, switched off)

This is part of the Vitanaland calendar redesign. The owner asked for the rest
of the plan to be built without waiting for input. It ships **switched off**:
it starts only when `CALENDAR_GOOGLE_SYNC_ENABLED` is exactly `true` **and**
`GOOGLE_OAUTH_CLIENT_ID`/`SECRET` are set. The flag is not pinned on any
environment, so turning it on is the owner's decision.

## Design

- **No second OAuth flow, no new token store.** The Google connector
  (VTID-01939) already stores tokens in `social_connections`, and the
  existing token refresher keeps them fresh. The sync reads them through
  the connector dispatcher (`getConnectorAccessToken`, a new export that
  reuses `loadConnection` and `refreshIfExpired`).
- **Narrow scopes.** A new Google sub-service, `calendar_sync`, asks for
  `calendar.app.created` and `calendar.freebusy` only. The first reaches
  only calendars the app itself created. The second returns busy times
  without any details. Connect link:
  `/api/v1/social-accounts/connect/google?include=calendar_sync&mode=incremental`.
- **Push.** The member's own `community`/`personal` entries go to a
  "Vitanaland" calendar the app creates. Entries from the admin and
  developer lenses never leave Vitanaland. Pushed events have Google
  reminders turned off, because Vitanaland already reminds (VTID-04338).
  A hash of each pushed event means an unchanged entry is not written
  again. Deleted, cancelled or re-roled entries are removed from Google.
  Entries older than the 7-day lookback keep their Google copy.
- **Pull.** Free/busy of the member's Google primary calendar for the next 30
  days is stored as intervals only and shown in `GET /events/window` as grey
  busy blocks (`source: 'google'`).
- **Routes.**
  - `GET /api/v1/calendar/google` returns availability and sync state.
  - `POST /google/enable` returns 503 `not_configured`, or 409
    `not_connected` plus the connect link, or 200.
  - `POST /google/disable`.
- **Loop.** Runs every 10 minutes and syncs up to 50 members per tick and
  100 Google writes per member.

## Acceptance criteria

- **AC-1:** Sync is off unless both the flag and the Google client are set.
  The tick makes no calls and the loop does not start.
  TEST: `vtid-04372-calendar-google-sync.test.ts` › pure parts / the tick does nothing at all while switched off.
- **AC-2:** An entry becomes a Google event with no Google reminders and a
  link back to the entry. Recurrence is sent as an RRULE. Only the member's
  own community/personal entries are pushed.
  TEST: `vtid-04372-calendar-google-sync.test.ts` › pure parts.
- **AC-3:** The push plan creates, updates, skips unchanged entries, and
  deletes cancelled, re-roled and deleted entries. It never deletes history
  outside the read window.
  TEST: `vtid-04372-calendar-google-sync.test.ts` › plans create, update, no-op and delete.
- **AC-4:** One run creates the Vitanaland calendar, pushes, replaces the
  busy intervals (times only) and clears the error. Google is only called on
  the app-created calendar and freebusy.
  TEST: `vtid-04372-calendar-google-sync.test.ts` › one sync run.
- **AC-5:** Recovery.
  - An event the member deleted in Google only loses its link.
  - If the Vitanaland calendar was deleted, the run forgets it so the next
    run recreates it.
  - A failure is recorded on the state row and emitted to OASIS once, not on
    every repeat.
  TEST: `vtid-04372-calendar-google-sync.test.ts` › one sync run.
- **AC-6:** Routes return 503 while off, 409 with the connect link while
  Google is not connected, and 200 otherwise.
  TEST: `vtid-04372-calendar-google-sync.test.ts` › routes.
- **AC-7:** The window read adds Google busy times only when sync is ready
  and busy blocks were asked for.
  TEST: `vtid-04372-calendar-google-sync.test.ts` › wiring.
- **AC-8:** The three new tables are service-role only (RLS on, no policies,
  no browser grants) and store no tokens.
  TEST: `vtid-04372-calendar-google-sync.test.ts` › the migration…; live check in `outputs/live-reads.json`.

## OASIS

- `calendar.google_sync.enabled` and `calendar.google_sync.disabled` are
  emitted by the routes, with payload `{user_id}`.
- `calendar.google_sync.failed` is emitted by the loop when a member's
  failure is new, with payload `{user_id, error}`.

## Not verified

No real Google call has been made. The flag is off everywhere, and the
Google OAuth client is not set on staging. The first real signal will be a
staging member connecting with `include=calendar_sync`, turning sync on, and
seeing a "Vitanaland" calendar appear in their Google account.
