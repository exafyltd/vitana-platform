# VTID-04999 - Kiro Phase 2: kiro-runner, per-user Kiro keys, Connect Kiro key field (staging)

Owner decision 2026-10-08 (Gate 1 yes). Sparring: `plan-sparring.md` (converged, 2 rounds). Staging only; production for the runner is a later VTID.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `GET|PUT|DELETE /api/v1/operator/kiro/key` (all `requireAdminAuth`, user id from the signed-in identity only) on the existing operator router; `GET /api/v1/operator/kiro/status` gains `runner_configured`. New private service `kiro-runner` (`/alive`, `/keys/:userId`, WS `/sessions`) at `http://kiro-runner.vitana.internal:8080`, bearer token.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/operator/kiro/key (staging, unauthenticated GET).

OASIS_PROOF: linking and revoking a key emit `operator.kiro.key_linked` / `operator.kiro.key_revoked` (vtid VTID-04999; user id and timestamp only, never the key), declared in the CicdEventType union.

CURL_PROOF: unauthenticated GET of `/api/v1/operator/kiro/key` answers 401 application/json (route exists), not an HTML 404.

## Acceptance criteria

AC-1: kiro-runner requires its bearer token on every route but `/alive`; keys are stored per user under `vitana/kiro/staging/users/<user_id>`, never echoed or logged; status never reads the value; revoke force-deletes and ends that user's sessions; each key secret carries a Deny-GetSecretValue-unless-runner-role resource policy.
  TEST: services/kiro-runner/test/runner.test.ts
AC-2: A session runs `kiro-cli acp` with the user's key in the child's env only (allowlisted env, no runner credentials), in a fresh per-session directory (cwd rewritten, removed at the end); missing key closes 4401, transient key-store error 1011, kiro-cli exit 1011, line over 1 MiB 1009, runner cap 4429, idle 4408, absolute lifetime 4410.
  TEST: services/kiro-runner/test/runner.test.ts
AC-3: The gateway remote backend drives the unchanged AcpClient / kiro-turn over the runner socket end to end (turn, model list, model switch); a user without a key gets `not_connected` with the link hint; the backend registers only with KIRO_ENGINE_ENABLED + KIRO_RUNNER_URL + KIRO_RUNNER_TOKEN.
  TEST: services/gateway/test/vtid-04999-kiro-runner-backend.test.ts
AC-4: The key routes are admin-only, take the user id only from the identity, forward to the runner, return only linked/updated_at, and log OASIS events without the key. AWS-PROD-DEPLOY-GATEWAY.yml carries no KIRO_RUNNER wiring.
  TEST: services/gateway/test/vtid-04999-kiro-runner-backend.test.ts
AC-5: The Kiro workspace card shows the caller's key status; not linked → password field + Link; linked → date + Replace + Revoke (confirmed); the field is cleared at once after Link and the key is kept nowhere in state or storage; no runner → "not available".
  TEST: services/gateway/test/command-hub/vtid-04999-kiro-key-field.test.ts
  UI: screenshots outputs/key-*.png (desktop 1400x900, mobile 390x844), no horizontal overflow; Link sends one PUT and clears the field; Revoke asks, then DELETEs
AC-6: The pinned kiro-cli 2.28.0 archive passes its sha256 check, runs on node:20-bookworm-slim, and the container answers /alive (CI `build` job of AWS-STAGE-DEPLOY-KIRO-RUNNER.yml on every PR).
  TEST: .github/workflows/AWS-STAGE-DEPLOY-KIRO-RUNNER.yml
AC-7: Existing Kiro suites, every test that reads the Command Hub app.js, and the operator pipeline regression stay green.
  TEST: services/gateway/test/vtid-04975-kiro-engine.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
