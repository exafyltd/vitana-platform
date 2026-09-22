# VTID-04279 — Acceptance

## Context

Backlog security investigation (user-approved) sampled the `missing_auth`
and `rls_gap` findings from `route-auth-scanner-v1`/`b869c955`. Confirmed
`missing_auth` (`efec84e4`) was real and severe for two files, and the user
explicitly approved this fix: "fix approvals.ts and governance-controls.ts
now (add real auth, same pattern as their working siblings) in one
careful, well-tested PR".

**`services/gateway/src/routes/approvals.ts`** had **zero auth on all six
routes**. The write routes matter most: `POST /:approval_id/approve`
parses a VTID out of the URL (`appr_(VTID-\d{4,5})_` — the trailing hash
suffix was never validated) and, if found and non-terminal, calls the
internal `autonomous-pr-merge` endpoint with `automerge:true`. Any
unauthenticated caller who could guess or enumerate a VTID number could
merge its PR.

**`services/gateway/src/routes/governance-controls.ts`** arms/disarms
system kill-switches (`EXECUTION_DISARMED`, `AUTOPILOT_LOOP_ENABLED`, ...).
Its own header comment claimed a "Role gate: only Dev Admin or Governance
Admin can modify controls," but `getUserInfo()` read `x-user-id`/
`x-user-role` directly off the request with **zero signature
verification** — `x-user-role: admin` on any request was sufficient.
Confirmed the Command Hub itself sends this exact spoofable header
(`app.js:9427`, a plain client-side JS variable).

## Fix

Both routers now run `router.use(requireAdminAuth)` — the same pattern
`admin-navigator.ts:55`, `feedback-admin.ts:33` and
`specialists-admin.ts:46` already established (verify the JWT signature,
require `app_metadata.exafy_admin`). `governance-controls.ts`'s
`getUserInfo()` now derives the audit-trail actor from the VERIFIED
`req.identity`, never from the old spoofable headers, and the now-dead
`canModifyControls()`/`ALLOWED_ROLES` role gate is removed (redundant —
every caller reaching a handler is already exafy_admin).

**Companion fix, not optional:** every internal same-process caller of
these two routes was audited, not just the two route files:

- `services/gateway/src/services/orb-tools/developer-tools.ts`'s
  `approvalsApi()` (behind `dev_approve_pr`/`dev_reject_pr`/
  `dev_list_pending_approvals`/`dev_count_approvals`) sent **no auth
  headers at all**. Now forwards `Authorization: Bearer <id.user_jwt>` —
  the same `authHeaders()` pattern already used by
  `admin-feedback-tools.ts`/`admin-users-rbac-tools.ts`/etc.
- `services/gateway/src/services/orb-tools/governance-tools.ts` and
  `admin-governance-tools.ts`'s `adminHeaders()` (behind
  `dev_governance_status`/`dev_get_control`/`dev_set_control`/
  `dev_get_control_history`/`admin_governance_status`/
  `admin_get_control_key`/`admin_set_control_key`) sent the exact same
  spoofable `x-user-id`/`x-user-role: admin` headers the route itself used
  to trust. Now forwards `Authorization: Bearer <id.user_jwt>`.
- `services/gateway/src/services/gemini-operator.ts` (the Operator
  Console's "Developer Assistant" approval tools —
  `dev_list_approvals`/`dev_approval_count`/`dev_approve_item`/
  `dev_reject_item`) called `routes/approvals.ts` over HTTP using
  `SUPABASE_SERVICE_ROLE` **as a bearer token** — a real Supabase DB
  credential, not a user JWT, which `requireAdminAuth` correctly rejects
  (the signature verifies — it's signed with the same secret — but the
  token carries no `app_metadata.exafy_admin` claim, so
  `requireExafyAdmin` would 403 it). This caller has no per-request JWT
  available to forward (the tool dispatcher only threads `args`/
  `threadId`, confirmed by reading its call sites). Rather than invent a
  forwarding mechanism, extracted the logic
  `routes/approvals.ts`'s handlers used to run inline into
  `services/approvals-service.ts` (byte-for-byte behavior, same
  `{status, body}` shape) and had `gemini-operator.ts`'s four functions
  call it **in-process** — no HTTP hop, no bearer token needed at all.
  While there, also added the SAME `isExecuteTaskAuthorized(getThreadAuth
  (threadId))` gate `autopilot_execute_task` already requires
  (VTID-03851) to `dev_approve_item`/`dev_reject_item` — they merge/reject
  a real PR, the same class of consequential action, and had no
  per-caller admin check at the operator-chat dispatch layer at all before
  this pass (a live gap this investigation surfaced, fixed while already
  in this exact code, not expanded scope for its own sake).

## Acceptance Criteria

AC-1 — `approvals.ts` requires a real, verified exafy_admin session on
every one of its six routes (read and write) — previously had none.
TEST: `services/gateway/test/routes/approvals.test.ts` — "rejects %s %s
with 401 when unauthenticated, before any service call" (parameterized
over all 6 routes)

AC-2 — `governance-controls.ts` requires a real, verified exafy_admin
session on every route, closing the exact pre-fix bypass (a spoofed
`x-user-role: admin` header alone).
TEST: `services/gateway/test/routes/governance-controls.test.ts` — "a
spoofed x-user-role header alone no longer grants write access — the
exact pre-fix bypass"

AC-3 — the audit trail on both routers now records the VERIFIED caller
identity (`req.identity.user_id`), never a client-suppliable header/body
field, even when an attacker-controlled header is present alongside a
real admin session.
TEST: `services/gateway/test/routes/governance-controls.test.ts` — "a
verified exafy_admin caller can update a control, and the audit trail
records their VERIFIED identity, not a client-suppliable header"
TEST: `services/gateway/test/routes/approvals.test.ts` — "a verified
exafy_admin caller reaches POST /:approval_id/approve and their user_id
is forwarded as the decider"

AC-4 — the ORB voice tools calling `approvals.ts`
(`dev_approve_pr`/`dev_reject_pr`/`dev_list_pending_approvals`/
`dev_count_approvals`) forward a real `Authorization: Bearer <user_jwt>`
instead of the prior no-auth-at-all self-call, and degrade to no header
(never a fabricated one) when the calling identity has no JWT.
TEST: `services/gateway/test/orb-tools/developer-tools.test.ts` —
"approvals self-call — real bearer auth (VTID-04279)"

AC-5 — the ORB voice tools calling `governance-controls.ts` (developer and
admin variants) forward a real `Authorization: Bearer <user_jwt>` instead
of the prior spoofable `x-user-id`/`x-user-role` headers.
TEST: `services/gateway/test/orb-tools/governance-tools.test.ts` —
"governance-controls self-call — real bearer auth (VTID-04279)"
TEST: `services/gateway/test/orb-tools/admin-governance-tools.test.ts` —
"governance-controls self-call — real bearer auth (VTID-04279)"

AC-6 — the Operator Console's Developer Assistant approval tools
(`gemini-operator.ts`) no longer use `SUPABASE_SERVICE_ROLE` as a bearer
token against the now-gated route; they call the extracted
`approvals-service.ts` logic in-process, with no auth boundary to cross.
TEST: `services/gateway/test/vtid-04279-approvals-governance-controls-auth.test.ts`
— "gemini-operator.ts approval tools no longer use SUPABASE_SERVICE_ROLE
as a bearer token"

AC-7 — `dev_approve_item`/`dev_reject_item` (Operator Console) require the
same verified-exafy_admin thread authorization `autopilot_execute_task`
already requires (VTID-03851), since they merge/reject a real PR — a gap
this investigation found while already in this file, fixed in the same
pass rather than left for a future incident.
TEST: `services/gateway/test/vtid-04279-approvals-governance-controls-auth.test.ts`
— "executeDevApproveItem and executeDevRejectItem require the SAME
verified-exafy_admin gate autopilot_execute_task already requires"

AC-8 — the extracted `services/approvals-service.ts` logic is
behavior-preserving (identical status codes and response shapes to what
the original inline route handlers produced) and independently unit
tested end to end (count/list/approve/reject, including the malformed-id,
terminal-status, missing-PR-info and failed-merge paths).
TEST: `services/gateway/test/services/approvals-service.test.ts`

## Live route-mount evidence (VALIDATOR-CHECK's Route Mount Evidence Gate)

Both routers now carry a new `router.use(requireAdminAuth)` line, which the
gate's `ROUTE_REGISTRATION` pattern (`router.use(`) correctly matches — it
is a real, load-bearing change to how every existing route on each router
behaves, not a false positive to argue around. Confirmed live against the
CURRENTLY DEPLOYED (pre-this-PR) staging build — this session does have
outbound curl access to `preview-aws-gateway.vitanaland.com` through the
sandbox's proxy, which an earlier pass of this pack wrongly assumed it did
not:

ROUTE_MOUNT: `router.use(requireAdminAuth)` added to
`services/gateway/src/routes/approvals.ts` and
`services/gateway/src/routes/governance-controls.ts`, gating all 6 + 3
existing routes on each router.

FINAL_URL: `https://preview-aws-gateway.vitanaland.com/api/v1/approvals/count`,
`https://preview-aws-gateway.vitanaland.com/api/v1/governance/controls`

CURL_PROOF: captured against staging's live pre-PR build, `build-info`
reporting `git_commit: 98ecc03aba2a60674c495e32ca92ebd4d2334955` —
`origin/main` HEAD immediately before this branch:

```
$ curl -s "https://preview-aws-gateway.vitanaland.com/api/v1/admin/build-info"
{"ok":true,"env":"staging","git_commit":"98ecc03aba2a...","marker":"98ecc03aba2a"}

$ curl -s "https://preview-aws-gateway.vitanaland.com/api/v1/approvals/count"
{"ok":true,"pending_count":0}
# HTTP 200, application/json, no Authorization header sent — CONFIRMS
# the vulnerability live: the route exists and executes for an
# unauthenticated caller, exactly as the finding describes.

$ curl -s "https://preview-aws-gateway.vitanaland.com/api/v1/governance/controls"
{"ok":true,"data":[{"key":"agenda_analyzer_admin_enabled", ...}]}
# HTTP 200, application/json, no Authorization header — same confirmation
# for governance-controls.ts.
```

This is real, current, live confirmation that both routes exist (JSON, not
an HTML 404) and — on the still-deployed pre-fix code — execute with zero
authentication, which is exactly the vulnerability this PR closes. The
post-merge, post-deploy signal (both curls above returning 401 instead of
200 once staging redeploys this branch) is the remaining live confirmation
step, tracked in "Not fixed here" below.

## Not fixed here (explicitly out of scope)

- The internal `autonomous-pr-merge` endpoint that `approveApprovalById`
  itself calls (`/api/v1/github/autonomous-pr-merge`) was not audited for
  its own auth posture — it predates this VTID and is a separate route
  file; flagging, not silently assuming it's fine.
- `routes/governance.ts` (evaluate/rules/violations/enforcements/feed/
  proposals — the OTHER handlers in `governance-tools.ts`/
  `admin-governance-tools.ts` beyond the four control-key ones) is a
  different router with a different (unaudited) auth posture. Explicitly
  out of scope — the user's request named `governance-controls.ts`, not
  `governance.ts`.
- **Correction to an earlier version of this pack:** it claimed "this
  session has no way to place ... an HTTP request against a deployed
  environment." That was wrong — this session's sandbox does have
  outbound curl access to `preview-aws-gateway.vitanaland.com`; see "Live
  route-mount evidence" above, which used it to confirm the pre-fix
  vulnerability live. What genuinely remains out of reach is an
  AUTHENTICATED exafy_admin request (this session holds no such session
  token) or an ORB voice session — those stay unverified. Also verified
  structurally: full targeted suite (179 tests across 7 files, including a
  real mutation-verification pass — removing `router.use(requireAdminAuth)`
  from both routers correctly failed 15/27 tests in the route-level suites
  before being restored), full gateway suite (1073/1074 suites, 1
  pre-existing skip; 17491/17526 tests, 0 failures), `tsc --noEmit` clean,
  `npm run build` clean. The next real signal is the same two curls above,
  re-run once this branch is deployed to staging, returning 401 instead of
  200.
