# VTID-04695 — JSON routes under /events are served as JSON

STAGING-VERIFY on gateway `d44591b` (2026-09-28) failed the VTID-04680 check
"calendar window requires auth": the route answered 401 with
`content-type: text/event-stream`. The global `sseHeaders` middleware set
event-stream headers on every GET whose path contains `/events`, and
`res.json()` keeps a Content-Type that is already set. Every GET under
`/events` in the gateway is a JSON route (calendar list/window/today/…,
universal-cart, product analytics, voice-lab debug, `/api/v1/oasis/events`,
which staging served as a JSON list labelled event-stream).

`/stream` paths are unchanged. A path under `/events` gets the stream headers
only when the client asks for `text/event-stream` (EventSource always does).

## Acceptance

AC-1: GET /api/v1/calendar/events/window, /api/v1/calendar/events, /api/v1/oasis/events and /api/v1/universal-cart/events get no SSE headers.
TEST: services/gateway/test/middleware/cors.test.ts

AC-2: GET /stream paths keep SSE headers; a GET under /events that asks for text/event-stream gets them.
TEST: services/gateway/test/middleware/cors.test.ts

AC-3: on staging the calendar window 401 and the OASIS events list are application/json.
CURL: curl -s -o /dev/null -w '%{content_type}' https://preview-aws-gateway.vitanaland.com/api/v1/oasis/events
