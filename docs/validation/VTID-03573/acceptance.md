# VTID-03573 — Self-healing control-plane auth: restore internal automated callers

## Context

PR #2884 added authentication to the self-healing router (`requireServiceOrAdmin`
on `/report`, `requireAdminOnly` on the mutation routes). The Codex review found
that three internal automated callers reach those routes without credentials, so
the new gate returns 401 and silently breaks them:

- `autopilot-event-loop.ts` `triggerVerify()` → `POST /self-healing/verify/:vtid`
  (automated blast-radius verification + auto-rollback)
- `voice-self-healing-adapter.ts` `postSelfHealingReport()` → `POST /self-healing/report`
  (classified ORB voice failures entering the repair pipeline)
- `orb-tools/self-healing-tools.ts` `dev_*` tools → config / kill-switch /
  approve / reject / verify / rollback (admin ORB developer tools)

This VTID restores those callers without weakening the gate.

## Acceptance criteria

AC-1 The `/verify/:vtid` route accepts the internal gateway service token
     (it is now `requireServiceOrAdmin`, not `requireAdminOnly`), so the
     autopilot event loop's automated blast-radius verification is not 401'd.
TEST: services/gateway/test/self-healing-control-plane-auth.test.ts

AC-2 The ORB self-healing developer tools forward the caller's admin JWT as a
     Bearer token on every gated call (report, config, kill-switch, verify,
     rollback), so an authorized admin's tools work through the new gate.
TEST: services/gateway/test/orb-tools/self-healing-tools.test.ts

AC-3 The control-plane auth gates and the P0-5 fail-closed default from #2884
     remain intact and green after these changes (no weakening of the gate).
TEST: services/gateway/test/self-healing-control-plane-auth.test.ts

## Notes on the two non-ORB internal callers

`triggerVerify()` (autopilot-event-loop) and `postSelfHealingReport()` (voice
adapter) are gateway-internal service-to-service HTTP calls. They now attach
`Authorization: Bearer ${GATEWAY_SERVICE_TOKEN}` (the same token the CI
health-report senders already use), which `requireServiceOrAdmin` accepts.
These two are exercised by the deployed staging environment after merge (they
depend on `GATEWAY_SERVICE_TOKEN` being present in the runtime environment,
which is not available to unit tests); the route-gate behavior they rely on is
covered by AC-1's suite.
