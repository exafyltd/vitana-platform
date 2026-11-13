# Acceptance: Bedrock lane reviewer — gateway review pass and route

VTID-05787, allocated by the VTID-ALLOCATE workflow.

## Criteria
1. A diff that touches a protected gate file is refused with `changes` and no model call is made.
2. The primary model (Opus 4.6) is tried first; a failure falls through to Sonnet 4.6.
3. An `accept` with any blocking finding is downgraded to `changes`.
4. When every tier fails, the result is `model_unavailable`, never `accept`.
5. A changed file outside the lane's allowed paths is refused with `changes` and no model call. The request must carry `allowed_paths`.
6. POST /api/v1/lane-review requires service or admin auth and rejects a malformed body.

## Evidence
- Behaviour checks for criteria 1–5 were run locally by compiling the modules and executing the same cases with Node: all passed.
- Jest cases: services/gateway/test/lane-review/review-pass.test.ts and services/gateway/test/lane-review.test.ts. Not run in this session (no registry access); CI runs them.
