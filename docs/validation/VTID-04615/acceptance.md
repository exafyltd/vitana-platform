# VTID-04615 — Command Hub pages under events/ and streams/ served as text/event-stream

Found by the read-only Command Hub E2E run against staging (hub-developer):
three screens failed because `#root` was not on the page at all.

## Evidence (staging, read-only GETs, `outputs/content-type-before.txt`)

| Path | Status | Content-Type |
|---|---|---|
| `/command-hub/command-hub/events/` | 200 | `text/event-stream` |
| `/command-hub/oasis/events/` | 200 | `text/event-stream` |
| `/command-hub/oasis/streams/` | 200 | `text/event-stream` |
| `/command-hub/oasis/` | 200 | `text/html; charset=UTF-8` |

The body is the normal Command Hub HTML (it contains `id="root"`), but the
browser treats a `text/event-stream` response as a stream and never renders it.

Cause: `sseHeaders` in `services/gateway/src/middleware/cors.ts`, mounted on the
whole app, sets `Content-Type: text/event-stream` on every GET whose path
contains `/stream` or `/events`. That includes these Command Hub screen URLs.

## Change

`sseHeaders` returns early for `/command-hub` and `/command-hub/*`. No SSE route
lives under `/command-hub`: every EventSource the Command Hub opens
(`app.js`, `orb-widget.js`) is under `/api/v1/`. API streams are unchanged.

## Acceptance criteria

AC-1 Command Hub screen paths containing events/ or streams/ get no SSE headers.
  TEST: services/gateway/test/middleware/cors.test.ts ("does NOT set SSE headers on Command Hub page %s (VTID-04615)")
AC-2 The API stream the Command Hub opens still gets SSE headers.
  TEST: services/gateway/test/middleware/cors.test.ts ("still sets SSE headers on the API stream the Command Hub opens")
AC-3 Existing sseHeaders behaviour (GET /stream, GET /events, POST /stream/send, unrelated paths) is unchanged.
  TEST: services/gateway/test/middleware/cors.test.ts (describe "sseHeaders")
AC-4 After deploy to staging, the three paths return text/html and the hub E2E run passes them.
  CURL: curl -s -o /dev/null -w '%{content_type}' https://preview-aws-gateway.vitanaland.com/command-hub/oasis/events/
