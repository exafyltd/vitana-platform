# VTID-05047 - Require a real caller on the remaining cicd routes (security fix, part 2)

Owner approval 2026-10-10 (Gate 1: "Yes"). Sparring: `plan-sparring.md` (converged, 2 rounds).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `POST /service`, `/merge`, `/deploy`, `/approvals/:id/approve`, `/approvals/:id/deny`, `/autonomous-pr-merge`, `/lock-release` and `GET /approvals`, `/lock-status` on the cicd router (mounted at `/api/v1/github`, `/api/v1/deploy`, `/api/v1/cicd`) now run `requireServiceOrAdmin` first. `GET /health` stays public.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/cicd/approvals (staging).

CURL_PROOF: anonymous GET of approvals and lock-status answers 401; POST autonomous-pr-merge and deploy/service with an invalid bearer answer 401; GET health answers 200.

OASIS_PROOF: unchanged; refused calls never reach the handler, so no cicd events are emitted for them.

## Acceptance criteria

AC-1: Each of the nine routes answers 401 without a bearer (all three prefixes), with a wrong bearer, or with no GATEWAY_SERVICE_TOKEN configured; 403 for a signed-in non-admin; the service token or an exafy_admin session passes the gate. GET /health needs no caller.
  TEST: services/gateway/test/vtid-05047-cicd-routes-auth.test.ts
  CURL: staging GET /api/v1/cicd/approvals -> 401 application/json
  CURL: staging GET /api/v1/cicd/lock-status -> 401 application/json
  CURL: staging POST /api/v1/github/autonomous-pr-merge with an invalid bearer -> 401 application/json
  CURL: staging POST /api/v1/deploy/service with an invalid bearer -> 401 application/json
  CURL: staging GET /api/v1/cicd/health -> 200 application/json
AC-2: Every in-repo caller sends the service token: approvals.ts and execute.ts self-calls, gemini-operator (deploy/service, lock-status; no Supabase key), ORB cicd tools (merge, lock-status, lock-release), openclaw-bridge (every gateway call).
  TEST: services/gateway/test/vtid-05047-cicd-routes-auth.test.ts
  TEST: services/gateway/test/vtid-05019-cicd-pr-routes-auth.test.ts

## Follow-up (out of scope, sparring F4)
gemini-operator's call to `/api/v1/approvals/:id/approve` (approvalsRouter, not cicd) still sends the Supabase service-role key as bearer.
