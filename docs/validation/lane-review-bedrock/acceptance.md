# Acceptance: Bedrock lane reviewer — gateway review pass and route

No VTID has been allocated for this work yet. Allocate one before merging to main, and move this file to docs/validation/<VTID>/.

## Criteria
1. A diff that touches a protected gate file is refused with `changes` and no model call is made.
2. The primary model (Opus 4.6) is tried first; a failure falls through to Sonnet 4.6.
3. An `accept` with any blocking finding is downgraded to `changes`.
4. When every tier fails, the result is `model_unavailable`, never `accept`.
5. POST /api/v1/lane-review requires service or admin auth and rejects a malformed body.

## Evidence
- Behaviour checks for criteria 1–4 were run locally by compiling the modules and executing the same cases with Node: all passed.
- Jest cases: services/gateway/test/lane-review/review-pass.test.ts and services/gateway/test/lane-review.test.ts. Not run in this session (no registry access); CI runs them.
