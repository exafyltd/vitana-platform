# VTID-05063 — ledger READ routes require a service token or admin login (step A, log mode)

Residual exposure (mandatory until Tier 2 ships): This change closes anonymous reads of the VTID ledger rows via the 13 Tier 1 route groups. Until the Tier 2 follow-up ships, anonymous callers can still read VTIDs and task titles/statuses through the OASIS event reads, `GET /api/v1/specs/:vtid` and (VTIDs only) `GET /api/v1/ops/health/vtid-ledger`. The directive 'every access must be authenticated' is NOT fully met until Tier 2 ships. The gateway service token is the Supabase service-role secret (`vitana/supabase/prod/service-role-key`), so the read gate and any caller holding the token carry that exposure.

Step A ships the gate with the code default `LEDGER_READ_AUTH_MODE=log` on staging and production: nobody is refused yet; would-be rejections are logged. Plan: `docs/validation/VTID-05063/plan-sparring.md` (3 rounds, escalated, owner-approved with the F20 fix).

## Acceptance criteria

AC-1: With `LEDGER_READ_AUTH_MODE=enforce`, every Tier 1 route returns 401 to an anonymous or bad-token request, 403 to a valid non-admin JWT, passes the service token or an `exafy_admin` JWT, and fails closed on a verifier crash.
TEST: services/gateway/test/vtid-05063-ledger-read-auth.test.ts — "enforce"; services/gateway/test/vtid-05063-ledger-read-routes.test.ts — "enforce"

AC-2: The default mode is `log`: requests pass, and each would-be rejection writes at most one line per key per 60 s (key = route + reason + origin host + first 40 UA chars) with method, route template, status, reason, sanitised UA and Origin/Referer host, never a token or query value; at most 200 dedupe keys and 120 lines per minute per process. `off` skips the check.
TEST: services/gateway/test/vtid-05063-ledger-read-auth.test.ts — "log (the default)", "log hygiene", "off skips the check entirely"

AC-3: Health and build-info routes stay anonymous; the gate is per route, never `router.use` or mount-level; the board route runs `cors(corsOptions)` before the gate.
TEST: services/gateway/test/vtid-05063-ledger-read-auth.test.ts — "VTID-05063 wiring"; vtid-05063-ledger-read-routes.test.ts — health, feed, OPTIONS and CORS cases

AC-4: Every known caller sends credentials: Command Hub Tier 1 reads (`buildContextHeaders()`, board unconditional) and `debug.html` (stored bearer from `localStorage['vitana.authToken']`, written by `performRefresh` at app.js:125); the voice tools `dev_discover_tasks`, `dev_get_vtid_projection`, `dev_get_allocator_status`, `dev_get_work_order`, the approvals tools, `task-state-query-service` discover and the gemini-operator approvals calls (`serviceAuthHeaders()`, per call site); `vtid-auto-close.cjs` read. `gatewayApiCall` still sends no credential by default. `mcp/vitana-work` is dormant (not built or deployed; sends `VITANA_API_KEY`).
TEST: vtid-05063-ledger-read-self-calls.test.ts; vtid-05063-command-hub-ledger-read-headers.test.ts; vtid-05063-ledger-read-auth.test.ts — "gateway self-calls (source)"; scripts/ci/vtid-auto-close.test.cjs — "sends the service token on the read"

AC-5: Staging only strips `LEDGER_READ_AUTH_MODE` in step A (no pin); the production workflow contains no `LEDGER_READ_AUTH_MODE`; the staging register step stays at or below 19,900 characters.
TEST: vtid-05063-ledger-read-auth.test.ts — "deploy workflows (step A: strip list only)"; staging-deploy-workflow-bash-syntax.test.ts; vtid-04677-scheduled-notifications-auth.test.ts

AC-6: The interceptor no longer spends the single-use refresh token on a 401 to a request that carried no Authorization header.
TEST: vtid-05063-command-hub-ledger-read-headers.test.ts — "the fetch interceptor skips the refresh…"

## Route mount

No route is added or moved. Fourteen existing GET registrations gain one middleware argument:

ROUTE_MOUNT: `oasis-tasks.ts` (3 GETs) and `oasis-vtid-ledger.ts` (1) and `tasks.ts` (3) stay on their routers mounted at `/`; `vtid.ts` `/list`, `/projection`, `/:vtid`, `/allocator/status` stay on the vtid router at `/api/v1/vtid`; `board-adapter.ts` `GET /` stays at `/api/v1/commandhub/board` and `/api/v1/board`; `approvals.ts` `/count`, `/pending` stay at `/api/v1/approvals` (`services/gateway/src/index.ts`). Same methods, paths and mount points as before.

FINAL_URL: `https://preview-aws-gateway.vitanaland.com/api/v1/vtid/projection?limit=1` (staging)

CURL_PROOF: not run in this session (no shell or gateway call permitted to the implementing session). In log mode the anonymous read still answers 200 and the proof of the gate is the unit and route suites; the after-step-B staging probes (anonymous Tier 1 GET → 401) belong to step B's `staging-tests.json`, not this one (F20).

## OASIS

OASIS_PROOF: no new topic. A rejected request never reaches a handler, so it emits nothing; log-mode would-reject lines are console telemetry, deliberately not OASIS events.

## Preconditions before step B / step D (recorded, not yet checked)

- P1: staging and production (`vitana-gateway-awsdr`) task definitions carry `GATEWAY_SERVICE_TOKEN` (presence only). Staging wires it in the workflow; production presence is unverified.
- P2: whether either task definition sets `GATEWAY_BASE_URL` (decides whether the ORB task-state discover call reaches the gateway at all; its default `http://localhost:3000` was deliberately not changed).
- P3: the boot line on the deployed revision shows `service_token_configured=true`.
- P4: the `GATEWAY_SERVICE_TOKEN` repo secret equals the gateway value (the auto-close read would log `invalid or expired token` otherwise).

## Next phase (step B, separate PR)

After the owner PUBLISHes step A and VTID-04727 to production: pin `{name:"LEDGER_READ_AUTH_MODE", value:"enforce"}` on staging (headroom exists: the register step is at most 19,900 chars), regenerate `conversation-flag-pins.generated.ts`, flip `smoke/gateway.json` "OASIS tasks list" to `expect_status: 401`, add the anonymous 401 probes to step B's own `staging-tests.json`. Production enforce is an env-only dispatch with `env_overrides={"LEDGER_READ_AUTH_MODE":"enforce"}` after a clean log window and the owner's explicit go; rollback is the same dispatch with `log`.

## Not verified here

- No test was run in the implementing session (no shell); GitHub CI runs the named suites. The register-step size bound (base at most 20,000 by the existing cap test, minus 240 re-indented spaces, plus 24 for the new strip entry, so at most 19,784) is computed, not measured; the new test asserts the 19,900 target.
- Runtime behaviour on staging/production, P1-P4, and which operators lack `exafy_admin` (the 403 log lines answer it).
