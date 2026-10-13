# VTID-05040 - Gate the gateway debug routes (Track S / S1, security fix)

Owner approval 2026-10-10 (Gate 1: "Yes approved"). Sparring: `plan-sparring.md` (converged, 2 rounds, expedited).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `GET /api/v1/orb/debug/context-bootstrap` and `GET /api/v1/orb/debug/tts` (orb-live router at `/api/v1/orb`) now run `requireAuth, requireExafyAdmin` first; `/debug/tts` answers 503 `DEBUG_ROUTE_DISABLED`. `GET /api/v1/orb/debug/brain-instruction` adds a tenant-scope check. `GET /api/v1/routing/debug` and `GET /api/v1/situational/debug` now run `requireAuth, requireExafyAdmin` first.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/orb/debug/context-bootstrap (staging).

CURL_PROOF: anonymous GETs to the gated debug routes answer 401 application/json; the dev-sandbox-only routes answer 404.

OASIS_PROOF: unchanged; refused calls never reach a handler and the handlers emit no OASIS events.

## Acceptance criteria

AC-1: An anonymous caller of GET /api/v1/orb/debug/context-bootstrap gets 401 JSON and the context builder is never called; a member gets 403; an exafy_admin gets 200.
  TEST: services/gateway/test/routes/s1-debug-route-gates.test.ts
  CURL: staging GET /api/v1/orb/debug/context-bootstrap?user_id=00000000-0000-0000-0000-000000000000 -> 401 {"error":"UNAUTHENTICATED"}
AC-2: GET /api/v1/orb/debug/tts is disabled: anonymous 401, member 403, exafy_admin 503 DEBUG_ROUTE_DISABLED; the handler contains no Google Cloud TTS call and the TTS client mock is never called.
  TEST: services/gateway/test/routes/s1-debug-route-gates.test.ts
  CURL: staging GET /api/v1/orb/debug/tts -> 401 {"error":"UNAUTHENTICATED"}
AC-3: GET /api/v1/orb/debug/brain-instruction: a member asking for another tenant gets 403 FORBIDDEN_TENANT_SCOPE; their own tenant gets 200; an exafy_admin may render another tenant; anonymous is still 401.
  TEST: services/gateway/test/routes/s1-debug-route-gates.test.ts
  CURL: staging GET /api/v1/orb/debug/brain-instruction -> 401
AC-4: GET /api/v1/orb/debug/memory and /debug/intent stay 404 off the dev sandbox.
  TEST: services/gateway/test/routes/s1-debug-route-gates.test.ts
  CURL: staging GET /api/v1/orb/debug/memory -> 404; GET /api/v1/orb/debug/intent?text=hi -> 404
AC-5: GET /api/v1/routing/debug and GET /api/v1/situational/debug: anonymous 401 JSON without the session/user listing, member 403, exafy_admin 200 with the cached snapshot. The existing situational-awareness debug assertions now send an admin identity.
  TEST: services/gateway/test/routes/s1-debug-route-gates.test.ts
  TEST: services/gateway/test/routes/situational-awareness.test.ts
  CURL: staging GET /api/v1/routing/debug -> 401 {"error":"UNAUTHENTICATED"}
  CURL: staging GET /api/v1/situational/debug -> 401 {"error":"UNAUTHENTICATED"}
AC-6: Drift guard: every `debug` route registration in src/routes/*.ts and src/index.ts is gated (requireExafyAdmin / requireVoiceLabDevAccess / requireAuth / requireAuthWithTenant / isDevSandbox, or a router-level router.use gate) or on an explicit allowlist with a reason; removing the middleware from context-bootstrap (or from situational/debug) fails both the route test and the guard (mutation check, commands.log).
  TEST: services/gateway/test/routes/s1-debug-route-gates.test.ts
