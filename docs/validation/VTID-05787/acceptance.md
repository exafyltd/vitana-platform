# Acceptance: Bedrock lane reviewer, gateway review pass and route

VTID-05787, allocated by the VTID-ALLOCATE workflow (run 43397162744, VTID_RESULT=VTID-05787).

AC-1: A changed file outside the lane's allowed paths is refused with `changes` and no model call.
TEST: services/gateway/test/lane-review/review-pass.test.ts > "refuses a file outside the lane allowed paths without calling a model"

AC-2: A changed protected gate file is refused with `changes` and no model call.
TEST: services/gateway/test/lane-review/review-pass.test.ts > "refuses a protected gate file without calling a model"

AC-3: The primary model (Opus 4.6) is tried first; a failure falls through to Sonnet 4.6.
TEST: services/gateway/test/lane-review/review-pass.test.ts > "falls back to the second model on a failure"

AC-4: An accept with any blocking finding is downgraded to `changes`.
TEST: services/gateway/test/lane-review/review-pass.test.ts > "downgrades an accept that has a blocking finding"

AC-5: When every tier fails the result is `model_unavailable`, never `accept`.
TEST: services/gateway/test/lane-review/review-pass.test.ts > "returns model_unavailable when every tier fails, never an accept"

AC-6: POST /api/v1/lane-review requires service or admin auth and rejects a malformed body.
TEST: services/gateway/test/lane-review.test.ts > "refuses a call without auth" and "rejects a body with a bad head sha"

## Route evidence
ROUTE_MOUNT: services/gateway/src/index.ts mounts /api/v1/lane-review (see outputs/route-mount.txt)
FINAL_URL: not yet available. The route is not deployed. It has no staging URL until this PR merges and the gateway staging deploy runs.
CURL_PROOF: not yet available. No curl has been run against a deployed route. Required after staging deploy; the staging-tests.json probe covers it.

## Allocation record
- VTID-05787 was allocated through the VTID-ALLOCATE workflow (run 43397162744), dispatched over the REST API from the Claude Code session.
