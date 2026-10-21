# VTID-04727 — ledger write routes require a service token or admin login

## Acceptance criteria

AC-1: With `LEDGER_WRITE_AUTH_MODE=enforce`, an anonymous or invalid-token request to any ledger write route gets 401, a valid non-admin JWT gets 403, and a JWT verification crash fails closed.
TEST: services/gateway/test/vtid-04727-ledger-write-auth.test.ts — "enforce" block
CURL: staging-tests.json rejected probes on complete / PATCH / DELETE for VTID-00000 expect 401

AC-2: `GATEWAY_SERVICE_TOKEN` or an `exafy_admin` JWT is accepted, and the verified actor (`service:internal` / `admin:<user_id>`) is recorded; an empty token never authorises.
TEST: services/gateway/test/vtid-04727-ledger-write-auth.test.ts — "accepts the service token…", "accepts an exafy_admin JWT…", "never authorises an empty service token"

AC-3: The default mode is `log`: the request is let through and every call that would be rejected is logged; `off` skips the check.
TEST: services/gateway/test/vtid-04727-ledger-write-auth.test.ts — "log (the default)", "off skips the check entirely"

AC-4: All six write routes carry the gate, the read routes do not, and a delete records the verified actor before the caller-supplied header.
TEST: services/gateway/test/vtid-04727-ledger-write-auth.test.ts — "VTID-04727 wiring"

AC-5: Every in-repo caller sends credentials: voice developer tools (6 writes), backlog script, VTID-AUTO-CLOSE workflow; staging pins `enforce`, production does not.
TEST: services/gateway/test/vtid-04727-ledger-write-auth.test.ts — wiring; scripts/ci/vtid-auto-close.test.cjs — "sends the service token on the close"

## Route mount

No route is added or moved. Six existing registrations gain one middleware argument, so the diff shows their lines as changed:

ROUTE_MOUNT: `POST/PATCH/DELETE /api/v1/oasis/tasks[/:id]` and `POST /api/v1/oasis/tasks/:vtid/complete` stay on `oasisTasksRouter` (`services/gateway/src/routes/oasis-tasks.ts`, mounted at `/`); `POST /allocate` and `POST /create` stay on the vtid router mounted at `/api/v1/vtid` (`services/gateway/src/index.ts`). Same methods, same paths, same mount points as before.

FINAL_URL: `https://preview-aws-gateway.vitanaland.com/api/v1/oasis/tasks/VTID-00000/complete` (staging)

CURL_PROOF: against staging on the pre-PR build (2026-09-29), write-free: `POST /api/v1/oasis/tasks/VTID-00000/complete` → `404 application/json` `{"ok":false,"error":"NOT_FOUND",…}` — the route exists (JSON, not an HTML 404) and an anonymous caller reaches the handler today, which is the gap this VTID closes; `GET /api/v1/oasis/tasks/VTID-04727` → `200 application/json`. After merge the staging suite expects the same POST to answer `401`. `allocate`/`create` were not curled: an accepted call would mint a real VTID.

## OASIS

OASIS_PROOF: no new topic. The gated routes keep emitting their existing events (`vtid.lifecycle.completed` / `vtid.lifecycle.failed` from the completion route, the delete route's event); a rejected request never reaches a handler, so it emits nothing. Log-mode rejections are console lines, deliberately not OASIS events (telemetry, CLAUDE.md §6).

## Not verified here

- Whether the production task definition carries `GATEWAY_SERVICE_TOKEN` (no AWS CLI in this session). In `log` mode, the voice tools' self-calls will show up as `would be rejected` lines if it does not.
- That the `GATEWAY_SERVICE_TOKEN` repo secret equals the gateway's value — same signal, from the auto-close workflow.
- Production `enforce` is a follow-up flip after the log lines are clean.
