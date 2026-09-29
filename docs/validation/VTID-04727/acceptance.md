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

## OASIS

OASIS_PROOF: no new topic. The gated routes keep emitting their existing events (`vtid.lifecycle.completed` / `vtid.lifecycle.failed` from the completion route, the delete route's event); a rejected request never reaches a handler, so it emits nothing. Log-mode rejections are console lines, deliberately not OASIS events (telemetry, CLAUDE.md §6).

## Not verified here

- Whether the production task definition carries `GATEWAY_SERVICE_TOKEN` (no AWS CLI in this session). In `log` mode, the voice tools' self-calls will show up as `would be rejected` lines if it does not.
- That the `GATEWAY_SERVICE_TOKEN` repo secret equals the gateway's value — same signal, from the auto-close workflow.
- Production `enforce` is a follow-up flip after the log lines are clean.
