# VTID-04473 — Jev (TypeSafe System One) integration, slice 1

Owner instruction (2026-09-25): "integrate jev but activate only the usage for
admin, developer, Backoffice, Staff, Professional but not for Community until
we figure out cost control."

Plan: `docs/JEV-INTEGRATION-PLAN.md`.

## Acceptance criteria

- AC-1: The Jev client posts the documented `/v1/systemone` contract, retries only 429/529, never throws, validates every answer against its question and refuses to call when not configured (flag `JEV_DECISIONS_ENABLED='true'` AND `TYPESAFE_API_KEY`).
  TEST: services/gateway/test/vtid-04473-jev-client.test.ts
- AC-2: Access: professional, staff, backoffice, admin, developer, infra, exafy_admin and system are allowed on the `internal` plane; community and patient are refused (`community_not_enabled`) unless `JEV_COMMUNITY_ENABLED` is exactly `true`; per-decision role lists hold.
  TEST: services/gateway/test/vtid-04473-jev-access-pii.test.ts
- AC-3: PII: emails, phones and IBANs are redacted before a state leaves (or the call is refused under `forbid`); ISO dates, versions and ids are untouched.
  TEST: services/gateway/test/vtid-04473-jev-access-pii.test.ts
- AC-4: `decide()` gates, validates, redacts, bounds the state, calls, interprets, abstains below the decision threshold, prices input tokens at $0.042/M unrounded, and emits exactly one `jev.decision.*` event without the state; a provider error is `failed`, not configured is `fallback` — never a silent default.
  TEST: services/gateway/test/vtid-04473-jev-decision-service.test.ts
- AC-5: `decideMany()` keeps input order and never exceeds its concurrency limit.
  TEST: services/gateway/test/vtid-04473-jev-decision-service.test.ts
- AC-6: Routes: role comes from `user_tenants.active_role`, never the body; community sees no decisions and gets 403; bulk document classification ranks relevant documents with token cost, answers 503 once when not configured, caps at 500; stats are exafy_admin only.
  TEST: services/gateway/test/routes/jev-decisions.test.ts
- AC-7: Staging wiring is optional (describe-secret, absent → inert), the key is a secret reference, `JEV_DECISIONS_ENABLED` is always written, community is never set, production is untouched.
  TEST: services/gateway/test/vtid-04473-jev-staging-wiring.test.ts

## Route mount

ROUTE_MOUNT: services/gateway/src/index.ts — `mountRouterSync(app, '/api/v1', jevDecisionsRouter, { owner: 'jev-decisions' })` (router `services/gateway/src/routes/jev-decisions.ts`)
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/jev/decisions (also POST /api/v1/jev/decisions/:name, POST /api/v1/jev/documents/classify, GET /api/v1/jev/admin/stats)
CURL_PROOF: before this PR, staging answers `404 text/html` "Cannot GET /api/v1/jev/decisions" (outputs/staging-before-curl.txt). After the staging deploy the same unauthenticated GET must answer `401 application/json` from `requireAuth`.

## OASIS

OASIS_PROOF: every decision call emits one of `jev.decision.completed` / `jev.decision.fallback` / `jev.decision.failed` (added to `CicdEventType`), vtid `VTID-04473`, source `jev:<caller>`, payload = decision, outcome, plane, role, actor, tenant, model, latency, input tokens, cost, confidence, reason, redactions — never the state. Asserted in the decision-service suite (captured `emitOasisEvent`). Denials and invalid input emit nothing (no spend happened).

## Not verified live

No TypeSafe key exists, so no real Jev call has been made. Until the owner runs `scripts/aws/setup-typesafe-secret.sh provision --env staging --apply`, staging deploys with `JEV_DECISIONS_ENABLED=false` and every decision answers 503 `not_configured`. The `score` answer scale is inferred from the docs (0..levels accepted, per-level probabilities preferred); the first live call pins it.
