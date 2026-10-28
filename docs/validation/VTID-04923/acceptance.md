# VTID-04923 — wire DAILY_API_KEY into the gateway task definitions

Unblocks VTID-04904's staging test ("live health reports the Daily.co key on the staging task definition") so the
gateway candidate can reach a fully green STAGING-VERIFY (owner decision 2026-10-06, option b). Nothing is
deployed to production by this change; the prod step applies only on an owner-approved prod deploy.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: none (deploy workflows + a test).

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/live/health (staging, read-only)

CURL_PROOF: after the merge's staging deploy, GET /api/v1/live/health on staging returns daily_configured: true (STAGING-VERIFY, docs/validation/VTID-04923/staging-tests.json).

OASIS_PROOF: n/a (no new topics; staging.verify.* carries the result).

## Acceptance criteria

AC-1: The staging deploy resolves vitana/gateway/staging/daily-api-key optionally (absent or denied → logged, deploy continues) and wires DAILY_API_KEY as a secret reference via connected-apps.json, before the task definition is registered.
  TEST: services/gateway/test/vtid-04923-daily-key-wiring.test.ts
AC-2: The production deploy wires DAILY_API_KEY from the full ARN of vitana/gateway/prod/daily-api-key (strip-then-add, exactly one entry), never a plain value and never the staging secret.
  TEST: services/gateway/test/vtid-04923-daily-key-wiring.test.ts
AC-3: Both deploy workflows keep valid bash in every run step and stay under the run-size cap.
  TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts
AC-4: On staging after merge, /api/v1/live/health reports daily_configured: true.
  CURL: GET https://preview-aws-gateway.vitanaland.com/api/v1/live/health
