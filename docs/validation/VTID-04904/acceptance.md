# VTID-04904 — Live Rooms: Daily rooms that can be joined (LR-A1)

Owner request 2026-10-05 (plan sparred, 2 rounds, converged; owner approved "Fix everything").

AC-1 Rate limits on /daily, /purchase and /sessions are keyed per verified user (optionalAuth); a forged/unverified token falls back to the IP bucket; /daily allows 30 per user per 15 min.
TEST: services/gateway/test/vtid-04904-live-daily-rooms.test.ts — "liveRateLimitKey", "per-user limiter on /daily (30 / 15 min)"

AC-2 Daily rooms are private and their exp is refreshed per session (ends_at, else starts_at + duration, + 2h, never before now + 4h); an existing room is updated, never returned stale.
TEST: services/gateway/test/vtid-04904-live-daily-rooms.test.ts — "computeDailyRoomExpiry", "DailyClient"

AC-3 /daily checks the host from the verified JWT: 401 without/with an invalid token, 403 for a non-host (no URL), the host gets an owner token; 503 when DAILY_API_KEY is missing.
TEST: services/gateway/test/vtid-04904-live-daily-rooms.test.ts — "POST /rooms/:id/daily"

AC-4 Room metadata is merged, never replaced (price survives a new session).
TEST: services/gateway/test/vtid-04904-live-daily-rooms.test.ts — "RoomSessionManager.createSession"

AC-5 /api/v1/live/health reports daily_configured (presence only).
TEST: services/gateway/test/vtid-04904-live-daily-rooms.test.ts — "GET /health"

ROUTE_MOUNT: `router.post('/rooms/:id/enter', requireAuth, ...)` and `router.post('/rooms/:id/exit', requireAuth, ...)` added in `services/gateway/src/routes/live.ts`, on the pre-existing liveRouter mounted at `/api/v1/live` (`mountRouterSync(app, '/api/v1/live', liveRouter, { owner: 'live' })`, services/gateway/src/index.ts:1261). `/rooms/:id/daily`, `/sessions`, `/purchase`, `/health` keep their existing paths.
FINAL_URL: `POST /api/v1/live/rooms/:id/enter`, `POST /api/v1/live/rooms/:id/exit` (and the existing `GET /api/v1/live/health`).
CURL_PROOF: pre-merge, the new routes are not deployed on staging (expected `404`). Post-merge expectation, checked read-only by STAGING-VERIFY: unauthenticated `POST /api/v1/live/rooms/<uuid>/enter` → `401 application/json` (router mounted, auth gate live); `GET /api/v1/live/health` → `200 application/json` with `daily_configured`. Route tests: services/gateway/test/vtid-04905-live-enter-exit.test.ts mounts the real router under `/api/v1/live`.
