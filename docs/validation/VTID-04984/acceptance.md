# VTID-04984 - Model selection inside Kiro threads

Owner decision 2026-10-08 (Gate 1 yes). Sparring: `plan-sparring.md` (converged). Models come only from Kiro; Operator (LLM) threads unchanged. Inert until Kiro is connected (Phase 2 of VTID-04975).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `GET /api/v1/operator/kiro/sessions/:threadId/models`, `POST /api/v1/operator/kiro/sessions/:threadId/model`, both `requireAdminAuth` on the existing operator router.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/operator/kiro/sessions/00000000-0000-0000-0000-000000000000/models (staging, unauthenticated GET).

OASIS_PROOF: switching a Kiro model emits `operator.kiro.model_selected` (vtid VTID-04984; user, thread and model id only), declared in the CicdEventType union.

CURL_PROOF: unauthenticated GET of the models route answers 401 application/json (route exists), not an HTML 404.

## Acceptance criteria

AC-1: The model list is read from what Kiro returns with the session: the ACP config option with category "model" (groups flattened) or the v2 `models` field.
  TEST: services/gateway/test/vtid-04984-kiro-model-selection.test.ts
AC-2: Switching goes through Kiro: session/set_config_option for a config-option list, session/set_model for a v2 list; Kiro's updated list is kept; Kiro's own error is passed through unchanged.
  TEST: services/gateway/test/vtid-04984-kiro-model-selection.test.ts
AC-3: Listing and switching are owner-only; the routes are admin-only and the switch logs `operator.kiro.model_selected`. Each Kiro reply carries the model that answered.
  TEST: services/gateway/test/vtid-04984-kiro-model-selection.test.ts
AC-4: In a Kiro thread with a session, the Command Hub shows Kiro's models in a dropdown with the current one selected, disabled during a turn; picking one switches it; Kiro's error message is shown; each Kiro reply shows "Kiro · <model>".
  TEST: services/gateway/test/command-hub/vtid-04984-kiro-model-select.test.ts
  UI: screenshots outputs/kiro-model-*.png (desktop 1400x900, mobile 390x844), no horizontal overflow; selecting a model sends the POST
AC-5: Every existing test that reads the Command Hub app.js, the Kiro suites and the operator pipeline regression stay green.
  TEST: services/gateway/test/vtid-04975-kiro-engine.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
