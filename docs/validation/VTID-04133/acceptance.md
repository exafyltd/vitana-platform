# VTID-04133 — Operator Console machine-to-machine auth

## Report

Adds an opt-in `X-Operator-Machine-Token` header auth path to
`POST /api/v1/operator/chat` and `/chat/stream`, resolving to a
clearly-synthetic identity (`operator-machine-test-harness`) that satisfies
the VTID-03851 `isExecuteTaskAuthorized()` exafy_admin gate — letting a
CI/test harness pass that gate without holding a human password. Only
fires when `optionalAuth` found no real identity, so a genuine human
session always wins. Gated on both `OPERATOR_MACHINE_AUTH_ENABLED` and
`OPERATOR_MACHINE_AUTH_TOKEN` being set; ships inert otherwise.

## Acceptance Criteria

AC-1 — `isOperatorMachineAuthEnabled()` and `verifyOperatorMachineAuthToken()`
in `services/gateway/src/services/operator-machine-auth.ts` correctly gate
on both the exact-string kill switch and a constant-time token comparison,
with every failure path (wrong token, missing config, length mismatch, an
empty candidate, a too-short placeholder secret) resolving to an
indistinguishable `false`, never a throw.
TEST: services/gateway/test/vtid-04133-operator-machine-auth.test.ts

AC-2 — `resolveOperatorMachineIdentity()` returns the synthetic identity
only when enabled AND the token matches, and returns `null` in every other
case (disabled, wrong token, missing header, array-valued header).
TEST: services/gateway/test/vtid-04133-operator-machine-auth.test.ts

AC-3 — The route wiring in `services/gateway/src/routes/operator.ts`
(`operatorMachineAuth` middleware) only assigns `req.identity` when
`optionalAuth` left it unset, so a real authenticated caller's identity is
never overridden by the machine credential.
TEST: services/gateway/test/vtid-04133-operator-machine-auth.test.ts (unit
coverage of the underlying resolver the middleware calls); the middleware's
own "never override a real identity" branch is a direct, one-line
conditional reviewed by hand — this diff does not add a route-level
integration test for that specific branch.

## Route evidence

The VALIDATOR-CHECK Route Mount Evidence Gate flagged this diff because it
changes the literal `router.post('/chat', ...)` / `router.post('/chat/stream',
...)` registration lines (inserting the new `operatorMachineAuth` middleware
argument) — its diff-based heuristic cannot distinguish "an existing route's
middleware chain changed" from "a brand-new route was added," since both show
up as a route-registration line being added in `git diff`. **No new route is
added by this PR** — `/chat` and `/chat/stream` are pre-existing, already-live
routes; only their middleware chain changed.

ROUTE_MOUNT: `POST /chat` and `POST /chat/stream` are mounted on the existing
operator router (`services/gateway/src/routes/operator.ts`) under
`/api/v1/operator`, exactly as before this PR — unchanged mount point,
unchanged HTTP method, unchanged path.

FINAL_URL: `https://preview-aws-gateway.vitanaland.com/api/v1/operator/chat`

CURL_PROOF: a live, real request against the currently-deployed (pre-this-PR)
route, proving it already exists — JSON content-type, not an HTML 404, per
this repo's own diagnostic in CLAUDE.md §15:

```
$ curl -s -o /dev/null -w "HTTP_STATUS:%{http_code} CONTENT_TYPE:%{content_type}\n" \
    -X POST "https://preview-aws-gateway.vitanaland.com/api/v1/operator/chat" \
    -H "Content-Type: application/json" -d '{}'
HTTP_STATUS:400 CONTENT_TYPE:application/json; charset=utf-8
{"ok":false,"error":"Validation failed","details":"message: Required"}
```

400 + `application/json` (not `text/html`) confirms the route exists and is
live today, before this PR's middleware change ships.
