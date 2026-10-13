# VTID-05122 — Command Hub spec-approve calls: dead path + dead x-user-* headers

Owner approval 2026-10-12 ("Yes" at Gate 1). Sparring: `plan-sparring.md` (standard, 2 rounds, CONVERGED).

Problem: Self-Healing → Active Repairs **APPROVE** posted to `POST /api/v1/specs/approve`, a route that does not exist (Express HTML 404), sent no Bearer token, and showed "Spec approved" whatever came back (no response check, no `.catch`) — a silent failure. The Task drawer's spec approve still sent `x-user-id` / `x-user-role`, which the gateway has ignored since VTID-05048.

VALIDATION_PROFILE: command_hub_frontend

ROUTE_MOUNT: no route added or changed. The frontend now calls the existing `POST /api/v1/specs/:vtid/approve` (`services/gateway/src/routes/specs.ts`, `requireServiceOrAdmin`, mounted at `/api/v1/specs` in `services/gateway/src/index.ts`).

FINAL_URL: https://preview-aws-gateway.vitanaland.com/command-hub/ (Self-Healing view, Active Repairs)

OASIS_PROOF: none — no event topic added or changed (the approve route's existing events are unchanged).

CURL_PROOF: `POST /api/v1/specs/VTID-00000/approve` with the runner's invalid bearer → 401 JSON `{ok:false}` on staging (route mounted and fail-closed, not an HTML 404). See `staging-tests.json`.

## Acceptance criteria

AC-1: Active Repairs APPROVE calls `POST /api/v1/specs/' + encodeURIComponent(task.vtid) + '/approve` with `buildContextHeaders(...)` (Bearer) in that fetch's init; app.js contains no `'/api/v1/specs/approve'`.
  TEST: services/gateway/test/command-hub/vtid-05122-spec-approve-route.test.ts
  CURL: GET /command-hub/app.js?v=20261118-vtid-05122 contains the new fetch (staging-tests.json)
AC-2: The success toast appears only inside an `if (r.ok && j && j.ok)` branch; otherwise an "Approve failed" toast is shown and the button re-enabled; network errors go through `.catch(` to an error toast. A mutation self-test proves the check detects an unconditional toast.
  TEST: services/gateway/test/command-hub/vtid-05122-spec-approve-route.test.ts
AC-3: app.js sends no `x-user-id` / `x-user-role` headers anywhere; the Task drawer approve still calls `'/api/v1/specs/' + vtid + '/approve'` with `buildContextHeaders(`; the approver stays resolved server-side from the JWT.
  TEST: services/gateway/test/command-hub/vtid-05122-spec-approve-route.test.ts
  TEST: services/gateway/test/vtid-05048-s4-caller-identity.test.ts
AC-4: The backend contract the frontend relies on holds: `router.post('/:vtid/approve', requireServiceOrAdmin` exists and no `router.post('/approve'` exists; on staging the route answers 401 JSON to an invalid caller.
  TEST: services/gateway/test/command-hub/vtid-05122-spec-approve-route.test.ts
  CURL: POST /api/v1/specs/VTID-00000/approve → 401 application/json (rejected probe, staging-tests.json)
AC-5: index.html loads `app.js?v=20261118-vtid-05122` (styles.css bumped with it, as every Command Hub test requires); every exact-version pin in older tests and staging suites follows; the ownership guard allowlists VTID-05122; the symbol index is regenerated.
  TEST: services/gateway/test/command-hub (54 suites)
  TEST: services/gateway/test/scripts/command-hub-ownership-guard.test.ts
  UI: https://preview-aws-gateway.vitanaland.com/command-hub/
