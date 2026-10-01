# Audiobook — acceptance (VTID-04760, VTID-04761, VTID-04762, VTID-04763)

Evidence pack for the gateway half of the Audiobook initiative
(exafyltd/vitana-platform#3836; frontend exafyltd/vitana-v1#1192). Command
output is in `commands.log` and `outputs/`. Staging change suites per VTID are
in `docs/validation/VTID-0476{0,1,2,3}/staging-tests.json`.

AC-1: A member's first-ever conversation opens with a welcome the model composes from an English intent (no hardcoded spoken sentence, no "90-day plan"), pointing at Episode 1 of the Audiobook; the LiveKit agent never reads that intent aloud.
TEST: services/gateway/test/services/assistant-continuation/providers/first-time-welcome/first-time-welcome.test.ts
TEST: services/gateway/test/orb/routes/livekit-first-turn-single-source.test.ts

AC-2: Vitana knows the guided view as the Audiobook / Hörbuch; "open my audiobook" / "zeig mir mein Hörbuch" switch to it; the greeting ladder's first-time rung invites Episode 1.
TEST: services/gateway/test/journey-modes-prompt.test.ts
TEST: services/gateway/test/nav-guided-journey.test.ts
TEST: npm run test:roles (services/gateway)

AC-3: GET /api/v1/journey/audiobook/topics/:topicId/audio serves a published topic's narration as audio/mpeg in the Vitana voice; 401 without sign-in, 400 for a malformed id, 404 for an unpublished topic, 422 when Polly has no voice for the language; never a partial render.
TEST: services/gateway/test/vtid-04761-audiobook-audio.test.ts
TEST: services/gateway/test/vtid-04761-audiobook-audio-route.test.ts

AC-4: The Prolog migration prepends T255-T260 as sessions 1-6 (chapter prolog), shifts the curriculum and member pointers by six, rewrites the current snapshot, and is idempotent.
TEST: services/gateway/test/vtid-04762-audiobook-prolog-migration.test.ts
TEST: docs/validation/VTID-04762/pglite-migration-check.mjs (executed, results in docs/validation/VTID-04762/migration-check.md)

AC-5: session-listened keeps the member's local-day record (one episode a day, synced across devices); POST /api/v1/journey/audiobook/reminder validates and stores the daily reminder and records the change in OASIS.
TEST: services/gateway/test/vtid-04763-audiobook-daily.test.ts
TEST: services/gateway/test/vtid-04763-audiobook-reminder-route.test.ts

AC-6: The daily reminder is claimed atomically once per local day (skipped after a listen, never failing on a bad zone) and pushed through the reminder_due delivery gate with localized text and a plain-path link; GET /api/v1/admin/tenants/:id/analytics/audiobook reports the four metrics.
TEST: services/gateway/test/vtid-04763-audiobook-daily.test.ts
TEST: docs/validation/VTID-04763/pglite-claim-check.mjs (executed, results in docs/validation/VTID-04763/claim-check.md)

## Routes added

ROUTE_MOUNT: services/gateway/src/routes/guided-journey.ts is mounted at /api/v1/journey (src/index.ts, unchanged) and gains GET /audiobook/topics/:topicId/audio and POST /audiobook/reminder; services/gateway/src/routes/tenant-admin/product-analytics.ts is mounted at /api/v1/admin/tenants/:tenantId/analytics (unchanged) and gains GET /audiobook.

FINAL_URL: /api/v1/journey/audiobook/topics/{topicId}/audio?lang={locale}, /api/v1/journey/audiobook/reminder, /api/v1/admin/tenants/{tenantId}/analytics/audiobook

CURL_PROOF: in-process HTTP against the mounted routers (supertest), outputs/route-tests.txt — e.g. "401 without a token", "200 audio/mpeg, private cache, in the requested language", "sets a valid reminder", "400 for {"time":"23:00","tz":"UTC"}". These routes do not exist on any deployed host before merge, so no live curl is claimed here; STAGING-VERIFY probes them on the staging gateway after merge (docs/validation/VTID-04761 and VTID-04763 staging-tests.json: anonymous GET audio → 401, anonymous POST reminder → 401, anonymous GET metrics → 401).

## OASIS

OASIS_PROOF: POST /audiobook/reminder emits `journey.audiobook.reminder.set` / `journey.audiobook.reminder.cleared` (vtid VTID-04763, actor, time, tz) — asserted by "records the opt-in and the opt-out as OASIS events" in services/gateway/test/vtid-04763-audiobook-reminder-route.test.ts (outputs/route-tests.txt). Existing listen path keeps its `index.recomputed` event unchanged.
