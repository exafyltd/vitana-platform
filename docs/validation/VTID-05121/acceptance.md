# VTID-05121 — autopilot-prompts member routes behind the pipeline service-token gate

## What happened
`routes/autopilot.ts` (the planner/worker/validator pipeline) gained
`router.use(requireServiceToken)` in the security audit #2867 (2026-08-10). It is
mounted at `/api/v1/autopilot` before the member-facing autopilot-prompts router,
which is mounted at the SAME prefix (`index.ts`). The gate therefore answered
`401 missing bearer token` / `invalid service token` to every member request for
`/prefs` and `/prompts/*` before the prompts router's own JWT gate
(`getUserContext`) ever ran. VTID-04530 fixed the same defect for
`/recommendations`; this is the sibling. No frontend calls these paths today.

## Fix
1. `requireServiceToken` hands `/prefs`, `/prefs/`, `/prompts` and `/prompts/*`
   to the next router with `next("router")`, after the health block (so
   `/prompts/health` keeps its `next()` path) and before the `/recommendations`
   block. Exact matching: `/prefsX`, `/promptsX`, `/prompt/...` stay gated.
2. The three write routes the hand-off re-opens get per-user limits
   (VTID-04904 pattern: `optionalAuth` before an `express-rate-limit` keyed on the
   verified user, else first XFF hop, else `req.ip`): `POST /prefs` 30,
   `POST /prompts/generate` 10, `POST /prompts/:id/action` 60, per 15 minutes.
   GET routes are not limited. Member auth in the handlers is unchanged.

## Acceptance criteria

AC-1: A member request (member JWT) to GET/POST /prefs, GET /prompts/today, POST /prompts/generate and POST /prompts/:id/action passes the pipeline gate and reaches the prompts router with its Authorization header untouched; /prefs/ too.
TEST: services/gateway/test/vtid-05121-autopilot-prompts-not-behind-service-token.test.ts ("service-token gate vs the autopilot-prompts router")
CURL: GET /api/v1/autopilot/prefs and /prompts/today on staging answer 401 {"ok":false,"error":"UNAUTHENTICATED"} (member gate), not "missing bearer token" (docs/validation/VTID-05121/staging-tests.json)

AC-2: Pipeline routes (/tasks/pending-plan, /controller/status, /loop/start) and look-alike paths (/prefsX, /promptsX, /prompt/today) still require the service token.
TEST: services/gateway/test/vtid-05121-autopilot-prompts-not-behind-service-token.test.ts
CURL: GET /api/v1/autopilot/controller/status on staging answers 401 "missing bearer token" (staging-tests.json)

AC-3: With the real autopilot-prompts router mounted after the pipeline router, GET /prefs with a member JWT reaches getPromptPrefs (200) and without a header answers 401 UNAUTHENTICATED from the member gate.
TEST: services/gateway/test/vtid-05121-autopilot-prompts-not-behind-service-token.test.ts ("real autopilot-prompts router behind the pipeline router")

AC-4: Per-user write limits: 11th POST /prompts/generate, 61st POST /prompts/:id/action and 31st POST /prefs from one verified user in 15 min answer 429 RATE_LIMIT_EXCEEDED while another user is unaffected; GETs are never limited; a forged (unverifiable) token gets no user bucket and shares the XFF bucket.
TEST: services/gateway/test/vtid-05121-autopilot-prompts-not-behind-service-token.test.ts ("per-user rate limits on the write routes")

AC-5: Guards stay tied to reality: index.ts mounts the pipeline router before the prompts router; every non-health prompts handler calls getUserContext; each write route runs optionalAuth before its limiter.
TEST: services/gateway/test/vtid-05121-autopilot-prompts-not-behind-service-token.test.ts ("pins")

AC-6: Existing behaviour unchanged: pipeline router (incl. VTID-03598 health exemptions), VTID-04530 recommendations hand-off, prompts route contract, VTID-05048 caller identity, roles and operator regression suites.
TEST: services/gateway/test/routes/autopilot.test.ts, test/vtid-04530-autopilot-recommendations-not-behind-service-token.test.ts, test/routes/autopilot-prompts.test.ts, test/vtid-05048-s4-caller-identity.test.ts, npm run test:roles, npm run test:operator

AC-7: The new suite fails when the fix is removed (mutation).
TEST: docs/validation/VTID-05121/outputs/mutation.txt

OASIS_PROOF: none. An auth routing fix plus request limits, no new state transition.

## Route mount evidence (VALIDATOR-CHECK route gate)

No route is added: the three write routes and the two read routes already exist and keep their mount. The
gate fires because their `router.post(...)` lines change (per-user limiter middleware inserted).

ROUTE_MOUNT: `autopilotPromptsRouter` stays mounted at `/api/v1/autopilot` in services/gateway/src/index.ts:884 via mountRouterSync, after the pipeline router at :881 whose `requireServiceToken` now hands `/prefs`, `/prefs/`, `/prompts` and `/prompts/*` on with `next("router")` (routes/autopilot.ts).
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/autopilot/prefs
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/autopilot/prompts/today
CURL_PROOF: before this change (staging @ origin/main, 2026-10-12 22:58 UTC, unauthenticated GET): `/api/v1/autopilot/prefs` → `401 {"ok":false,"error":"missing bearer token"}` and `/api/v1/autopilot/prompts/today` → `401 {"ok":false,"error":"missing bearer token"}` (the pipeline service-token gate). After merge-to-main auto-deploys staging, the same GETs must return `401 application/json {"ok":false,"error":"UNAUTHENTICATED"}` (the member router's own JWT gate), never `404 text/html`; STAGING-VERIFY runs these probes from staging-tests.json.
TEST: services/gateway/test/vtid-05121-autopilot-prompts-not-behind-service-token.test.ts
