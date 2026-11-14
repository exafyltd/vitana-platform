# VTID-05731 — gateway-critical-route-auth, lane `worker-orchestrator-auth`

Plan: `.kiro/specs/gateway-critical-route-auth/plan.md` (§2, §4 lane `worker-orchestrator-auth`) on
`origin/kiro/gateway-critical-route-auth/plan`. Base `origin/main` 6dc6e1ba0c.

The 12 write routes of the worker orchestrator had no auth (mounted at `/`, `index.ts:870`). They now take the
existing `requireServiceOrAdmin` (`middleware/require-service-or-admin.ts`): `Bearer <GATEWAY_SERVICE_TOKEN>` or an
`exafy_admin` JWT. The GET routes are unchanged and stay open. No migration, no new middleware, no secret.
**Production is unchanged until an owner PUBLISH.**

## What changed

- `services/gateway/src/routes/worker-orchestrator.ts`: `requireServiceOrAdmin` is the first middleware of
  `POST route` (:226), `POST subagent/start` (:320), `POST subagent/complete` (:365), `POST orchestrator/complete` (:522),
  `POST register` (:894), `DELETE register/:worker_id` (:992), `POST tasks/:vtid/claim` (:1233), `POST tasks/:vtid/release` (:1335),
  `POST tasks/:vtid/progress` (:1382), `POST heartbeat` (:1450), `POST await-autopilot-execution` (:1592, gate :1594),
  `POST cleanup` (:1719). The claim fail-open (base `:1260-1264`) is untouched; it stays with the autonomy-risk plan.
- `services/gateway/src/services/autopilot-event-loop.ts:533`: the dispatch to `/api/v1/worker/orchestrator/route`
  sends `...gatewayServiceAuthHeader()`.
- `services/gateway/src/services/orb-tools/developer-tools.ts:105-141`: `gatewayApiCall` adds the service bearer
  **only when the normalised path starts with `/api/v1/worker/`**. A caller-supplied `Authorization` still wins.
  - Why scoped: `gatewayApiCall` has about 250 call sites in 31 files. Many send no header to routes that are
    already `requireServiceOrAdmin`, for example `self-healing-tools.ts:63` → `POST /api/v1/self-healing/report`
    (`self-healing.ts:402`). Adding the token to every call would silently give those calls service authority.
    With the scope, only the orchestrator callers change, and they were unauthenticated before.
  - Host: `gatewayBaseUrl()` is `GATEWAY_URL` or `http://localhost:$PORT` (`developer-tools.ts:101-103`). Staging
    sets `GATEWAY_URL` to the gateway's own URL (`AWS-STAGE-DEPLOY-GATEWAY.yml:1251`). No non-gateway host gets the token.
  - The ORB tools that reach these routes (`vtid-lifecycle-tools.ts:364,428`, `worker-orchestrator-tools.ts:86,135,174`)
    are behind `developerGate` (developer, admin, exafy_admin). They act with service authority on the orchestrator.
    That is the same reach as today, when the routes were open.
- `services/gateway/src/services/self-healing-reconciler.ts:169` (`attemptRedispatch`): the redispatch POST to
  `/api/v1/worker/orchestrator/route` sends `...gatewayServiceAuthHeader()` (import `:36`). Without it, every
  redispatch would fail as `dispatch_http_401`. This file is outside plan §4's path list; changed on the owner's
  instruction for this pass.
- `services/gateway/test/worker-orchestrator-await-autopilot.test.ts`: sets `GATEWAY_SERVICE_TOKEN` in `beforeEach`
  (restored in `afterEach`) and sends `Authorization: Bearer <token>` on all 11 requests. No assertion changed.
  Outside plan §4's path list; changed on the owner's instruction for this pass.

## Acceptance criteria

AC-1 Each of the 12 write routes without a bearer returns 401 and the handler does not run (no fetch).
TEST: services/gateway/test/worker-orchestrator-auth.test.ts ("no token → 401 and the handler never runs", ×12)

AC-2 Each of the 12 write routes with a wrong bearer (not the service token, no exafy_admin identity) returns 401.
TEST: services/gateway/test/worker-orchestrator-auth.test.ts ("wrong token → 401 …", ×12)

AC-3 Each of the 12 write routes with `Bearer <GATEWAY_SERVICE_TOKEN>` reaches its handler (status not 401/403, no gate error).
Observed: 400 from the handler's own validation on 10 routes; 200 on `DELETE register/:id` and `cleanup` (mocked Supabase).
TEST: services/gateway/test/worker-orchestrator-auth.test.ts ("service token → handler runs (not 401/403)", ×12)

AC-4 GET routes stay open.
TEST: services/gateway/test/worker-orchestrator-auth.test.ts ("GET … stays open", health and skills)

AC-5 The autopilot event-loop dispatch sends `Authorization: Bearer <GATEWAY_SERVICE_TOKEN>`, and sends none when the
token is unset (the route then answers 401). The test drives `startEventLoop` under fake timers, because
`triggerDispatch` is module-private.
TEST: services/gateway/test/worker-orchestrator-auth.test.ts ("autopilot event loop dispatch …")

AC-6 `gatewayApiCall` sends the service bearer on `/api/v1/worker/*` to `gatewayBaseUrl()`. A caller's own
`Authorization` wins. Non-worker paths and dot-segment escapes (`/api/v1/worker/../…`, `%2e%2e`) get no service bearer.
TEST: services/gateway/test/worker-orchestrator-auth.test.ts ("gatewayApiCall")

AC-7 The self-healing reconciler's redispatch POST to `/api/v1/worker/orchestrator/route` sends
`Authorization: Bearer <GATEWAY_SERVICE_TOKEN>`, and none when the token is unset. `attemptRedispatch` and
`runReconcileCycle` are module-private, so the test drives the exported `startReconciler()` under fake timers (first
cycle after 30 s). The module reads `SUPABASE_URL` and `GATEWAY_URL` at load, so it is loaded with
`jest.isolateModules` after the env is set. `self-healing-probe` is mocked as unhealthy, so the cycle takes the
redispatch path; fetch serves one stale non-voice row and its ledger spec.
TEST: services/gateway/test/worker-orchestrator-auth.test.ts ("self-healing reconciler redispatch …")

AC-8 Red on base, green after. With the `origin/main` versions of the four source files (`worker-orchestrator.ts`,
`autopilot-event-loop.ts`, `developer-tools.ts`, `self-healing-reconciler.ts`) in place: 31 failed, 25 passed of 56
(outputs/jest-red-on-base.txt). After: 56 passed, plus 11 of 11 in the await-autopilot suite (outputs/jest-green.txt).
`npx tsc --noEmit --preserveSymlinks` exits 0 (outputs/tsc-gateway.txt).
TEST: docs/validation/VTID-05731/outputs/jest-red-on-base.txt, docs/validation/VTID-05731/outputs/jest-green.txt

## Callers that will get 401 and need a follow-up (outside this lane's files, not edited)

1. **worker-runner (production blocker).** It registers, heartbeats, claims, reports progress, completes and calls
   `await-autopilot-execution`. Its source is not in the repo: it was removed by 9dec0c4399 "Retire worker-runner and
   autopilot-worker (VTID-04327) (#3610)", while `.github/workflows/AUTO-DEPLOY.yml:29,164,214` still references
   `services/worker-runner/**`. Before production, either the deployed worker-runner sends `Bearer <GATEWAY_SERVICE_TOKEN>`
   on every write, or it is confirmed no longer running. Otherwise every claim and report gets 401. The PR body must name this.
2. `mcp/vitana-work/src/lib/gateway-client.ts:150` (header `:89`): sends `Bearer <VITANA_API_KEY>` when set. It works
   only if that value is the service token or an exafy_admin JWT. This is a developer-run MCP, not a production service.

Fixed in this pass (no longer on this list): the self-healing reconciler redispatch (AC-7) and
`test/worker-orchestrator-await-autopilot.test.ts` (11/11, outputs/jest-existing.txt).

Not breaking: `services/gateway/src/services/test-contract-commands.ts:230` (live probe of `await-autopilot-execution`
without a token) accepts `[400, 401]`
(`supabase/migrations/20260521000001_VTID_02955_test_contracts_fix.sql:195`). `crew_template/crew.yaml:147` is a config
value that no code reads. vitana-v1 `origin/main` (e31bf462) has no caller.

## Notes

- `npx tsc --noEmit --preserveSymlinks` exits 0. `--preserveSymlinks` is needed because the worktree's
  `node_modules` is a symlink to another worktree; without it the command reports 59 TS2742 errors, none in the
  touched files.
- Existing related suites: 12 of 12 pass, 417 tests (outputs/jest-existing.txt).
- The reconciler's own suites (`self-healing-reconciler-autopilot-link`, `vtid-04636-reconciler-lineage`,
  `vtid-05023-auth-bridge-reconciler`): 3 of 3 pass, 40 tests (outputs/jest-existing-reconciler.txt).

AC-9 With `GATEWAY_SERVICE_TOKEN` unset, the reconciler (and the event loop, same helper) logs `[worker-orchestrator-auth] GATEWAY_SERVICE_TOKEN unset: orchestrator dispatch will get 401` once per process instead of failing silently (plan sparring R1-F2 of PR #4971). The variable is set on the staging gateway task (`.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml:1320`).
TEST: services/gateway/test/worker-orchestrator-auth.test.ts ("logs one error per process when GATEWAY_SERVICE_TOKEN is unset (sparring R1-F2)", "logs no such error when the token is set")

## Known change for developers
`mcp/vitana-work` (`src/lib/gateway-client.ts:73,89`) sends `Bearer ${VITANA_API_KEY}`. After this lane its orchestrator calls work only when that value is the service token or an exafy_admin JWT. It is a developer-run MCP, not a deployed service; not changed here (plan sparring R1-F1 of PR #4971).

## Route mount evidence (Validator Check)
No route is added: the routes and their mounts exist on `main`; the change inserts a middleware or verification into existing registrations.
ROUTE_MOUNT: unchanged — `services/gateway/src/index.ts:870` (router at `/`)
FINAL_URL: the 12 POST/DELETE routes under /api/v1/worker/ of routes/worker-orchestrator.ts (paths unchanged)
CURL_PROOF: not run. No live or staging request was made; the staging proof is `staging-tests.json`, run by STAGING-VERIFY after a staging deploy, recorded here only with a run id.
