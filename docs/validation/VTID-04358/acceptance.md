# VTID-04358 — Calendar step 7a: private ICS subscription feed

This is step 7 of the Vitanaland calendar redesign; steps 1–6 are VTID-04320
to VTID-04357. The owner asked for the calendar to reach external calendars:
"ICS, then Google". This VTID is the ICS half.

## Design

- **One private link per user.**
  - The link is `GET /api/v1/calendar/feed/<token>.ics`. The token is 256
    random bits in base64url.
  - Only its SHA-256 hash is stored, in `calendar_feed_tokens`. The table
    alone never yields a working URL.
  - Creating a new link replaces the old one. Revoking deletes it.
  - Unknown, revoked and malformed tokens all get the same `404 Not found`.
- **What leaves the platform.**
  - The user's own entries, from 30 days back to 180 days ahead, with
    recurring series expanded.
  - Each entry carries its title, its time, and its place when one exists.
  - Descriptions stay out, because they can hold health details.
  - Alarms stay out, because Vitanaland already sends its own reminders and
    an external alarm would double every one.
  - Work-lens items (VTID-04357) are not calendar rows, so they never appear.
- **Routes.**
  - `GET`/`POST`/`DELETE /subscription` require sign-in.
  - `POST` returns a path, not a URL, so no host is hardcoded. The client
    prefixes the gateway base it already uses.
  - Only `/feed/*` is open.
- **Caching.** The feed is served `Cache-Control: private, max-age=900` and
  `X-Robots-Tag: noindex`, and asks subscribers to refresh hourly.

## Acceptance criteria

| AC | Criterion | Evidence |
|---|---|---|
| AC-1 | Valid RFC 5545: CRLF line endings, 75-octet folding without splitting UTF-8 characters, TEXT escaping, UTC times, a default 30-minute length. | TEST: `services/gateway/test/vtid-04358-calendar-ics-feed.test.ts` ("RFC 5545 formatting") |
| AC-2 | No descriptions and no alarms in the feed. | TEST: same file |
| AC-3 | Tokens are 256-bit. Only the hash is written or queried. A malformed token never reaches the database. | TEST: same file ("tokens") |
| AC-4 | The feed reads only the requesting user's non-cancelled rows. | TEST: same file |
| AC-5 | The feed needs no bearer and returns `text/calendar`, cached privately. Every bad token gets the same 404. The subscription endpoints and every other calendar route still require sign-in. | TEST: same file ("routes", via supertest) |
| AC-6 | The table stores one row per user, a hash only, with RLS on and no browser access. | TEST: same file ("migration") · live: RLS true, 0 policies, `anon`/`authenticated` SELECT false |

## Not verified

- A real calendar app (Apple, Google or Outlook) subscribing to a staging
  link. That needs this PR deployed and a signed-in user to create a link,
  which writes one row. It is the user's to do; this session creates no link.
- The app-side button to create, copy and revoke the link ships in
  `exafyltd/vitana-v1` on the same branch.
- Google two-way sync (OAuth) is step 7b.
