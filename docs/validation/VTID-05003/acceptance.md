# VTID-05003 - Kiro as the Operator's default engine (Kiro Power seats), visible fallback, production runner

Owner decision 2026-10-09 (Gate 1 yes). Sparring: `plan-sparring.md` (converged, 2 rounds). Dev Autopilot and every LLM-routing stage stay on Bedrock.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `GET /api/v1/operator/kiro/status` (existing, `requireAdminAuth`) now per signed-in user: adds `key_linked`, `credits`, `default_engine`.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/operator/kiro/status (staging, unauthenticated GET).

CURL_PROOF: unauthenticated GET answers 401 application/json (route exists), not an HTML 404.

OASIS_PROOF: a user's Kiro Power seat running out of credits emits `operator.kiro.credits_exhausted` (vtid VTID-05003; user id, thread id, source) once per transition, declared in the CicdEventType union.

## Acceptance criteria

AC-1: New threads default to Kiro exactly when the engine is on, the runner is configured, the signed-in user's own key is linked and their credits are not used up; anything unknown defaults to the Operator. The runner lookup has a 2 s timeout and a 60 s per-user cache cleared on link/revoke.
  TEST: services/gateway/test/vtid-05003-kiro-default-engine.test.ts
AC-2: An empty model list on session open, or a credit/quota error from Kiro, marks the user's seat used up, closes that session, answers `no_credits` with the reason and logs the OASIS event once per change; a session with a model marks it ok again; users are independent; state expires after 1 h.
  TEST: services/gateway/test/vtid-05003-kiro-default-engine.test.ts
AC-3: The Command Hub applies the default on + New, re-reads the status every new thread, never overrides the user's own choice or a thread with messages; a Kiro reply that could not be served shows "Continue in Operator", which opens an Operator thread with the last message pre-filled and sends nothing.
  TEST: services/gateway/test/command-hub/vtid-05003-kiro-default-engine-ui.test.ts
  UI: screenshots outputs/kiro-fallback-*.png (desktop 1400x900, mobile 390x844), no horizontal overflow
AC-4: Production runner: `AWS-PROD-DEPLOY-KIRO-RUNNER.yml` is dispatch-only, OIDC, promotes the staging-built image by tag with no rebuild, production names only; the production gateway is wired only to `kiro-runner-prod` when `KIRO_RUNNER_PROD_TOKEN_ARN` is set (else `KIRO_ENGINE_ENABLED=false`) and verifies it after the roll; staging and production never cross.
  TEST: services/gateway/test/vtid-05003-kiro-default-engine.test.ts
  TEST: services/gateway/test/vtid-04999-kiro-runner-backend.test.ts
AC-5: Existing Kiro suites, every test reading app.js, and the operator pipeline regression stay green.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
