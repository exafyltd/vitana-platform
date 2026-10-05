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
