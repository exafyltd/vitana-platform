# VTID-04530 — Community Autopilot popup: 401 on every member request

## What happened
`routes/autopilot.ts` (the planner/worker/validator pipeline, VTID-0532) gained
`router.use(requireServiceToken)` in the security audit #2867 (2026-08-10). That
router is mounted at `/api/v1/autopilot`, **before** the member-facing
recommendations router at `/api/v1/autopilot/recommendations` (`index.ts`), so
the gate ran for every member request too and answered
`401 invalid service token` to the member's own JWT. The popup shows
"Could not load recommendations — Fetch failed: 401". Member activations fell
from 62 in the week of 3 Aug to 0 every week since (`outputs/live-evidence.txt`).

Nothing caught it because every test mounts one router alone; no test mounted
them in production order. The CA-0..CA-9 staging check on 24 Sep also missed it:
it counted a 401 on `/recommendations` as "requires login" without reading
which router answered it.

## Fix
`requireServiceToken` hands `/recommendations` and `/recommendations/*` to the
next router (`next('router')`), next to the existing `/recommendations/health`
exemption. The recommendations router checks the member's own login
(`optionalAuth` plus a 401 UNAUTHENTICATED gate on every path but `/health`), so this opens nothing.
Pipeline routes keep requiring the service token.

## Acceptance criteria

AC-1: Member requests to the recommendations router (list, count, activate, draft) pass the pipeline gate with a member JWT.
TEST: services/gateway/test/vtid-04530-autopilot-recommendations-not-behind-service-token.test.ts

AC-2: Pipeline routes and a look-alike prefix (`/recommendationsX`) still require the service token.
TEST: services/gateway/test/vtid-04530-autopilot-recommendations-not-behind-service-token.test.ts

AC-3: The guard stays tied to reality: index.ts still mounts the pipeline router first, and the recommendations router still verifies member identity itself.
TEST: services/gateway/test/vtid-04530-autopilot-recommendations-not-behind-service-token.test.ts

AC-4: Existing pipeline-router behaviour is unchanged.
TEST: services/gateway/test/routes/autopilot.test.ts

OASIS_PROOF: none. An auth routing fix, no new state transition.

## After deploy
Staging: `GET /api/v1/autopilot/recommendations/count` with a bogus bearer must answer
`401 UNAUTHENTICATED` from the recommendations router, not `invalid service token`.
Production stays broken until promoted (PUBLISH), because production runs the same commit.
