# VTID-05019 - Require a real caller on POST /create-pr and /safe-merge (security fix)

Owner approval 2026-10-10 (Gate 1: "Yes"). Sparring: `plan-sparring.md` (converged, 3 rounds).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `POST /create-pr` and `POST /safe-merge` on the cicd router (mounted at `/api/v1/github`, `/api/v1/deploy`, `/api/v1/cicd`) now run `requireServiceOrAdmin` first.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/github/safe-merge (staging).

CURL_PROOF: POST with an invalid bearer answers 401 application/json on create-pr and safe-merge (before: 400, body validation, i.e. no auth at all).

OASIS_PROOF: unchanged; refused calls never reach the handler, so no cicd events are emitted for them.

## Acceptance criteria

AC-1: Without a bearer, with a wrong bearer, or with no GATEWAY_SERVICE_TOKEN configured, both routes answer 401 and nothing is created or merged; a signed-in non-admin gets 403; the gateway service token or an exafy_admin session reaches the handler. Same on all three mount prefixes.
  TEST: services/gateway/test/vtid-05019-cicd-pr-routes-auth.test.ts
  CURL: staging POST /api/v1/github/create-pr with an invalid bearer -> 401 application/json
  CURL: staging POST /api/v1/cicd/safe-merge with an invalid bearer -> 401 application/json
AC-2: Every in-repo caller sends the service token: the Operator/Kiro executors (no Supabase key on the self-call any more), the autopilot event loop, the ORB developer tools (per call site), openclaw-bridge (those two paths only).
  TEST: services/gateway/test/vtid-05019-cicd-pr-routes-auth.test.ts
  TEST: services/gateway/test/vtid-05014-kiro-v1-writes.test.ts
