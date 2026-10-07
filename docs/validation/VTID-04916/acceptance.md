# VTID-04916 — share a calendar entry to the news feed (platform part)

Plan: `plan-sparring.md` (converged, 3 rounds, plan hash `e64911d9c6d0734acc94b829b02e0991ac172df64b28a7895bebc46b6f06ac38`), Phase 2.
The app part (share panel on the calendar entry, the event card on feed posts) and the `profile_posts` migration are exafyltd/vitana-v1 under the same VTID.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `POST /api/v1/calendar/events/:id/share-to-feed` in `services/gateway/src/routes/calendar.ts` (calendar router, already mounted at `/api/v1/calendar`).

FINAL_URL: `https://preview-aws-gateway.vitanaland.com/api/v1/calendar/events/<id>/share-to-feed` (staging).

CURL_PROOF: staging probe — unauthenticated POST answers 401 (`staging-tests.json`, rejected write probe). No authenticated call is made against any shared environment: a share is a public post with a tenant-wide notification.

OASIS_PROOF: `calendar.shared_to_feed` (vtid VTID-04916) is emitted on each successful share; asserted in the route tests.

## Acceptance criteria

AC-1: Only entries backed by a community event or a live room session can be shared; private entries, health/lab/journey/autopilot entries and cancelled entries answer 409 NOT_SHAREABLE with a reason.
  TEST: services/gateway/test/vtid-04916-calendar-share.test.ts
AC-2: The event must still exist, not be over, not be cancelled, and a live room must be public.
  TEST: services/gateway/test/vtid-04916-calendar-share.test.ts
AC-3: The author is the verified caller; another member's entry answers 404; the body accepts only text and is_public.
  TEST: services/gateway/test/vtid-04916-calendar-share.test.ts
AC-4: One share per member per event (409 ALREADY_SHARED with the existing post id, also when two requests race onto the unique index); at most 5 event shares per member per 24 h (429 SHARE_LIMIT); the database's duplicate-text guard answers 409 DUPLICATE_POST, its hourly limit 429 RATE_LIMITED, a suspended account 403.
  TEST: services/gateway/test/vtid-04916-calendar-share.test.ts
AC-5: The calendar window marks each entry shareable and carries shared_post_id once shared; a failing lookup never breaks the window.
  TEST: services/gateway/test/vtid-04916-calendar-share.test.ts
  TEST: services/gateway/test/calendar (golden re-recorded: shareable/shared_post_id fields, new route)
AC-6: The notification type community_event_shared is in the catalog (member, posts), so it is listed and switchable per tenant; it starts OFF per tenant until an admin enables it (VTID-04674).
  TEST: services/gateway/test/vtid-04674-notification-type-controls.test.ts
AC-7 (vitana-v1 migration): clients cannot attach an event to a post (insert refused, update keeps the old reference, both PostgREST claim styles); one share per member per event; share notifications deduplicated per recipient per event per 24 h; posts without an event notify exactly as before.
  TEST: exafyltd/vitana-v1 scripts/sql-tests/run-event-share-posts-test.sh (CI SQL-EVENT-SHARE-POSTS)
