# VTID-05126 — share any of my upcoming calendar entries (feed + chat) — gateway part

Plan: `plan-sparring.md` (converged, 2 rounds, plan hash `49a0a63f9193c4d8173e7a324fd1af5d6fa9ec1ba71340d46704146876853c8a`, owner approved 2026-10-12).
The app part and the database migration are exafyltd/vitana-v1 under the same VTID
(`supabase/migrations/20261012120000_vtid_05126_profile_posts_calendar_entry_share.sql`).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `POST /api/v1/calendar/feed-posts/:postId/add` (new) and `POST /api/v1/calendar/events/:id/share-to-feed` (body gains `card_title`, `include_location`) in `services/gateway/src/routes/calendar.ts` (mounted at `/api/v1/calendar`); `GET /api/v1/calendar/events/window` items gain `invitable` and `sensitive`.

FINAL_URL: `https://preview-aws-gateway.vitanaland.com/api/v1/calendar/feed-posts/<post_id>/add` (staging).

CURL_PROOF: staging probes — unauthenticated requests answer 401 (`staging-tests.json`). No authenticated call is made against any shared environment.

OASIS_PROOF: `calendar.feed_post.added` (vtid VTID-05126) when a member adds a shared entry; `calendar.shared_to_feed` / `calendar.invite.sent` from Vitana's tools as before.

## Acceptance criteria

AC-1: Any of the member's own upcoming entries can be shared and invited to, whatever its source; never a cancelled, completed, ended or recurring entry.
  TEST: services/gateway/test/vtid-05126-calendar-share-any-entry.test.ts
AC-2: An entry that belongs to a community event or live room is still shared as that event (never `calendar_entry`), so the one-share-per-event rule holds.
  TEST: services/gateway/test/vtid-05126-calendar-share-any-entry.test.ts
  TEST: services/gateway/test/vtid-04916-calendar-share.test.ts
AC-3: A `calendar_entry` post carries a snapshot of exactly title, times, emoji and status, and the place only when the member chose to show it; the member may rename it for the card; nothing else of the entry is copied.
  TEST: services/gateway/test/vtid-05126-calendar-share-any-entry.test.ts
AC-4: The invite card for an own entry follows the same choices (title, place).
  TEST: services/gateway/test/vtid-05126-calendar-share-any-entry.test.ts
  TEST: services/gateway/test/vtid-04917-calendar-invite-audiobook.test.ts
AC-5: "In meinen Kalender" copies only the card of a public `calendar_entry` post into the viewer's calendar, never the author's own post, re-reads the current card, refuses a cancelled or finished entry, and is idempotent.
  TEST: services/gateway/test/vtid-05126-calendar-share-any-entry.test.ts
AC-6: The calendar window marks each own entry `shareable` / `invitable` / `sensitive`.
  TEST: services/gateway/test/calendar/calendar-routes.contract.test.ts
AC-7: Vitana's share and invite tools (and `send_calendar_invite_in_chat`) accept any own entry with the member's card choices; a health entry is posted or sent only with `sensitive_ack`, never on a bare confirmation.
AC-7b (Codex review): a confirmed share or invite of an own entry must carry the `card_token` of the preview the member approved; a dropped `card_title`, an added place or a missing token posts or sends nothing (`STATUS: card_changed`). The chat-invite message text says only what the card shows (card title; the place only when shown). The LiveKit agent's three tools take the same arguments (`card_title`, `include_location`, `card_token`, `sensitive_ack`).
  TEST: services/gateway/test/vtid-04918-calendar-assistant-parity.test.ts
  TEST: services/gateway/test/vtid-05104-calendar-invite-guard.test.ts

## Decisions taken
- The snapshot follows the entry's times, status and (only where already shown) place; the card title stays the member's choice and is never overwritten by later edits of the calendar title.
- `send_calendar_invite_in_chat` (VTID-05104, added in parallel) got the same health confirmation and card options, since it uses the same invite builder.
- Tests pinning the old rule ("private kinds refused") were updated to the owner's new rule (2026-10-12).
