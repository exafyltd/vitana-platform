# VTID-04917 — invite to a calendar entry through the messenger; the audiobook reminder in the calendar (platform part)

Plan: `plan-sparring.md` (converged, 3 rounds, plan hash `e64911d9c6d0734acc94b829b02e0991ac172df64b28a7895bebc46b6f06ac38`), Phase 3.
The app part (Invite on the calendar entry, the picker, the invite card in chats, "Listen now" on the audiobook entry) is exafyltd/vitana-v1 under the same VTID.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `GET /api/v1/calendar/events/:id/invite-preview`, `GET /api/v1/calendar/invites/:messageId`, `POST /api/v1/calendar/invites/:messageId/respond` in `services/gateway/src/routes/calendar.ts` (calendar router, mounted at `/api/v1/calendar`); `message_type 'calendar_invite'` on the existing `POST /api/v1/chat/send` and `POST /api/v1/chat/groups/:id/send`.

FINAL_URL: `https://preview-aws-gateway.vitanaland.com/api/v1/calendar/invites/<message_id>/respond` (staging).

CURL_PROOF: staging probes — unauthenticated requests answer 401 (`staging-tests.json`). No authenticated call is made against any shared environment: an invite is a chat message to real people.

OASIS_PROOF: `calendar.invite.responded` (vtid VTID-04917) on every answer; `journey.audiobook.reminder.set|cleared` now carries `payload.calendar` (upserted | cancelled | failed). Asserted in the route tests.

## Acceptance criteria

AC-1: The invite card is built on the server from the sender's own entry: a community event or public live room session the sender is going to (event title, never private fields), or the sender's own one-off entry (manual / invite). Never someone else's entry, a cancelled, finished or recurring entry, or a health, lab, appointment, plan, journey, Autopilot, subscription, reminder, audiobook or assistant entry. Client-sent card fields are ignored.
  TEST: services/gateway/test/vtid-04917-calendar-invite-audiobook.test.ts
  TEST: services/gateway/test/vtid-04917-invite-routes.test.ts
AC-2: The DM and group send routes accept `calendar_invite`, store only the server-built card, answer a refusal with its status and reason and insert nothing; every other message type is unchanged.
  TEST: services/gateway/test/vtid-04917-invite-routes.test.ts
AC-3: Only the DM recipient or a member of the group can answer, never the sender or a stranger; every answer is one row per member per message in calendar_invite_responses.
  TEST: services/gateway/test/vtid-04917-calendar-invite-audiobook.test.ts
AC-4: "I'm in" on a free community event joins it through global_event_participants (the database adds the calendar entry); a paid (ticket price or is_paid) or full event, and a live room, open their own page instead; an event that is over is not joined; Maybe/No never touch participation. On an own plan, "I'm in" copies it into the recipient's calendar (source_ref_type calendar_invite, source_ref_id = message id) and "No" removes the copy.
  TEST: services/gateway/test/vtid-04917-calendar-invite-audiobook.test.ts
AC-5: The card state route returns the viewer's answer and the counts, to the sender and the members only.
  TEST: services/gateway/test/vtid-04917-calendar-invite-audiobook.test.ts
  TEST: services/gateway/test/vtid-04917-invite-routes.test.ts
AC-6: Setting the audiobook reminder writes one daily calendar entry (source_type audiobook, FREQ=DAILY in the member's zone, DST-correct start today, reminder_offsets empty so the calendar never pushes); clearing it cancels the entry; a calendar failure never fails the reminder.
  TEST: services/gateway/test/vtid-04917-calendar-invite-audiobook.test.ts
  TEST: services/gateway/test/vtid-04763-audiobook-reminder-route.test.ts
AC-7: 'audiobook' is an allowed source_type in the code and in the newest constraint migration (every existing value kept).
  TEST: services/gateway/test/vtid-04917-calendar-invite-audiobook.test.ts
  TEST: services/gateway/test/vtid-04331-calendar-data-model.test.ts
