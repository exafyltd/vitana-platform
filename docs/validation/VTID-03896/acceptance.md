# VTID-03896 — Command Hub Operator: terminalize-on-completion, step feed, SSE tail, heartbeat

Companion work in the same PR, own VTIDs, own acceptance criteria below:
**VTID-03895** (vtid_ledger terminalization on execution completion),
**VTID-03897** (SSE live tail of the step feed), **VTID-03898** (last_event_at
heartbeat on the `/executions` list).

## Report

User audit request: "Give me summary full list of what is wired to Command
Hub Operator and what is your advice to further add to make it fully work
like Claude Code running for hours and displaying every single step of the
execution, so developer can track the process. But also when task is done
to display in Task Management as Completed." Produced a 4-item prioritized
recommendation list; user replied "ok, i agree with your recommendation and
priority order. but go ahead and execute all of them" — explicit approval
to implement all four, in order.

Root cause found for the "Completed" gap (VTID-03895): Operator on-ramp
executions that ran to full completion (merged + deployed cleanly) never
terminalized their `vtid_ledger` row — nothing in `dev-autopilot-execute.ts`
ever wrote `is_terminal=true`/`terminal_outcome` for the VTID the Operator
had activated via `autopilot_recommendations.activated_vtid`, so Task
Management's board (which reads `is_terminal`/`status`) showed the card
stuck `IN_PROGRESS` forever.

## Acceptance Criteria

AC-1 — `applyExecTerminalSideEffects()` (`dev-autopilot-execute.ts`)
propagates a terminal `dev_autopilot_executions` status
(`completed`/`failed`/`cancelled`) to the `vtid_ledger` row named by
`autopilot_recommendations.activated_vtid`, setting `is_terminal=true` and
the corresponding `terminal_outcome` (`success`/`failed`/`cancelled`).
Autonomous-plane findings (no `activated_vtid`) are left untouched.
`cancelExecution()`'s direct-PATCH path (bypasses `patchExecution()`) also
reaches this code.

TEST: `outputs/jest-new-vtid-suites.txt` —
`test/vtid-03895-terminalize-vtid-ledger.test.ts`, all 8 cases (completed/
failed/cancelled PATCH shapes, non-terminal statuses never PATCH,
autonomous-plane finding skipped, missing finding_id bails early, a failed
PATCH is logged not thrown, `cancelExecution()`'s direct-PATCH path also
terminalizes).

AC-2 — `GET /api/v1/dev-autopilot/executions/:id/steps` returns an
execution's `dev_autopilot.execution.*` OASIS events
(`metadata->>execution_id`-scoped, `topic=ilike.dev_autopilot.*`), ordered
oldest-first, gated behind `requireDevRole`.

TEST: `outputs/jest-new-vtid-suites.txt` —
`test/vtid-03896-03898-execution-steps-stream.test.ts`, "VTID-03896" block
(401/403 auth, 200 with correct PostgREST filter, 500 surfaces the
PostgREST error).

ROUTE_MOUNT: `GET /executions/:id/steps` and `GET /executions/:id/stream`
ride the existing Dev Autopilot router mount — `devAutopilotRouter`
(`services/gateway/src/routes/dev-autopilot.ts`), mounted at
`/api/v1/dev-autopilot` in `services/gateway/src/index.ts:811`
(`mountRouterSync(app, '/api/v1/dev-autopilot', devAutopilotRouter, {
owner: 'dev-autopilot' })`) — no new router or mount point added.

FINAL_URL:
`https://preview-aws-gateway.vitanaland.com/api/v1/dev-autopilot/executions/<id>/steps`
and
`https://preview-aws-gateway.vitanaland.com/api/v1/dev-autopilot/executions/<id>/stream`

CURL_PROOF: after merge-to-main auto-deploys staging, run:
`curl -s -o /dev/null -w "%{http_code} %{content_type}" -H "Authorization: Bearer <dev-token>" https://preview-aws-gateway.vitanaland.com/api/v1/dev-autopilot/executions/<real-exec-id>/steps`
must return `200 application/json...` (a JSON `{ok:true,steps:[...]}` body,
not an HTML 404) for a real execution id, and `401 application/json...`
with no token. Not yet run against staging from this session — no AWS/live
staging credentials available here; the route's shape is verified
structurally by the unit test above, which exercises the real Express
router with a mocked `fetch`/auth layer rather than a live server.

AC-3 — `GET /api/v1/dev-autopilot/executions/:id/stream` is a Server-Sent
Events live tail of the same feed: polls `oasis_events` every 2s, forwards
each new row as an `event: step`, and closes itself (`event: terminal` then
ends the response) the moment a terminal execution topic
(`dev_autopilot.execution.completed`/`failed`/`cancelled`/`reverted`/
`auto_archived`) arrives, or on client disconnect. A scoped
`requireDevRoleForStream` middleware additionally accepts the bearer token
via `?access_token=`, since the browser's native `EventSource` cannot set a
custom `Authorization` header — folded in only on this one route so the
token doesn't land in access logs for every other `dev-autopilot` GET.

TEST: `outputs/jest-new-vtid-suites.txt` —
`test/vtid-03896-03898-execution-steps-stream.test.ts`, "VTID-03897" block
(401 with neither header nor query token; the query-token fallback
authenticates and streams `connected`+`step`+`terminal` frames end-to-end
through the real route handler; the query token never overrides an
already-present `Authorization` header; a non-admin query token still 403s).

AC-4 — `GET /api/v1/dev-autopilot/executions` is enriched with a batched
`last_event_at: string | null` per row (one extra `oasis_events` query using
`metadata->>execution_id=in.(...)`, bounded, `order=created_at.desc` so the
first row per id is the most recent), so the Command Hub can tell a
long-running-but-healthy execution from a silently stuck one without a
separate request per card. A failure in the enrichment query degrades to
`last_event_at: null` on every row rather than turning the list endpoint
into a 500.

TEST: `outputs/jest-new-vtid-suites.txt` —
`test/vtid-03896-03898-execution-steps-stream.test.ts`, "VTID-03898" block
(most-recent-row-wins per execution id, no-match → null, empty execution
list never queries `oasis_events` at all, a failed enrichment query still
returns 200 with `last_event_at: null`).

AC-5 — Command Hub frontend (`app.js`): a "Steps" toggle beside the
existing "Lineage" button on each `dev_autopilot_executions` card, opening
a live `EventSource`-backed panel using named `addEventListener('step'
/'terminal'/'connected', ...)` handlers (not the codebase's pre-existing
`onmessage`-only pattern in `connectOasisStream()`, which is a latent gap
this PR does not touch), plus a `last_event_at` heartbeat badge on active
executions. All new visual elements use CSS classes
(`.dev-autopilot-heartbeat`, `.dev-autopilot-ghost-toggle`,
`.dev-autopilot-steps-*`, `styles.css`) rather than scripted inline
`.style` assignment, per the CSP Governance Gate's `CSP_PATTERNS`.

UI: not independently screenshotted — this session has no live
authenticated Command Hub session/browser to reach. Verified via
`node --check app.js` (syntax), a local run of
`scripts/ci/validator-path-guard.cjs --csp-added-lines` against this PR's
own diff (see `commands.log`), and manual review of the DOM/class wiring
against the existing "Lineage" toggle's established pattern in the same
file.

## OASIS impact

OASIS_IMPACT: yes

OASIS_PROOF: AC-1's `terminalizeVtidLedgerForExecution()` calls
`cicdEvents.vtidLifecycleCompleted()`/`vtidLifecycleFailed()`
(`oasis-event-service.ts`) on every on-ramp execution terminalization —
these helpers already exist and already emit `vtid.lifecycle.completed`/
`vtid.lifecycle.failed` OASIS events elsewhere in the codebase, but this PR
is the first call site to invoke them from the Operator on-ramp completion
path specifically. Verified structurally: `test/vtid-03895-terminalize-vtid-ledger.test.ts`
asserts `vtidLifecycleCompleted`/`vtidLifecycleFailed` are called with the
correct VTID/source/message on each terminal status. Not yet observed as a
real `oasis_events` row for a real operator-onramp execution in
staging/production — no live access from this session to watch
`oasis_events` after this deploys.
