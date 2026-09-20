# VTID-04209 — Acceptance

The Operator Console's `POST /api/v1/operator/chat` (and its
`/chat/stream` sibling, which shares the same `runOperatorChatTurn()`)
already resolves and trusts a caller's verified identity for authorization
purposes (`callerIdentity`/`geminiUserRole`, derived from the real JWT via
`optionalAuth` — VTID-03926) but never surfaced that fact to the operator
looking at the console. A reply produced anonymously and one produced
under a verified exafy_admin session looked identical in the UI.

## What already existed vs. what was added

No existing field on the reply's `meta` carried this — confirmed by
reading `processWithGemini()`'s own meta construction
(`provider`/`model`/`usage`/`cost_usd`/`cost_priced`/`model_calls`/
`duration_ms`, per VTID-04031) and `routes/operator.ts`'s `response.meta`
line. Per the task's own instruction to reuse an existing field rather
than invent one if possible, and since none exists, the smallest possible
addition was made: `runOperatorChatTurn()` now merges
`authenticated: geminiUserRole === 'admin'` into `response.meta`, reusing
the SAME `geminiUserRole` value this route already computes from the
already-verified `callerIdentity` (never from anything the model or a
client-supplied header could influence — the route's own comment already
records that `x-operator-role` is spoofable and must never be trusted for
authorization; this field is display-only and touches no authorization
decision).

## Fix

- `services/gateway/src/routes/operator.ts`: `response.meta` now includes
  `authenticated`, computed once, shared by both `/chat` and
  `/chat/stream` since both call the same `runOperatorChatTurn()`.
- `services/gateway/src/frontend/command-hub/app.js`: `renderOperatorChat()`
  renders a small `.message-auth-badge` ("admin"/"anon") from
  `msg.meta.authenticated` when present, independent of the pre-existing
  `msg.meta.provider` gate that controls the VTID-04031 cost badge (so a
  turn with no tool/provider call still shows the auth state).
- `services/gateway/src/frontend/command-hub/styles.css`: two small,
  subtle badge styles reusing this file's existing color tokens
  (`--color-text-secondary` for admin, `--color-operator`'s amber for
  anon — no new colors invented).
- `services/gateway/src/frontend/command-hub/index.html`: cache-bust
  bumped for both `app.js`/`styles.css`.
- `scripts/ci/command-hub-ownership-guard.js`: `VTID-04209` added to
  `ALLOWED_VTID_PATTERN` (this guard hard-gates every PR touching
  `services/gateway/src/frontend/command-hub/**`), plus a changelog-style
  comment entry matching the file's own convention.

## Acceptance criteria

AC-1: a reply from an authenticated admin caller is visually marked
differently from one produced by an anonymous caller.
TEST: `services/gateway/test/vtid-04209-operator-auth-state-badge.test.ts`
— the four backend `meta.authenticated` tests (true for admin, false for
anonymous/non-admin/spoofed-header) plus the frontend "renders
'admin'/'anon' from msg.meta.authenticated..." test.

AC-2: the new backend field defaults to reflecting the existing real
identity check and does not change any authorization behavior — display
only.
TEST: same file — "never trusts the client-supplied x-operator-role
header" (mirrors VTID-03926's own non-negotiable invariant for
`userRole`) and "preserves every other field processWithGemini already
returned on meta" (confirms the change is additive, not a replacement).
No authorization code path (`isExecuteTaskAuthorized`, `geminiUserRole`'s
own use for `dev_*` tool gating) was touched.

AC-3: the new test covers both the authenticated and anonymous rendering
paths.
TEST: same file — backend tests for both states, plus the frontend
source-level assertions confirming both `message-auth-badge--admin` and
`message-auth-badge--anon` are rendered/styled.

## Verification

`node --check` on `app.js` — clean. `tsc --noEmit` clean.

Own suite: 11/11 tests passing — 5 backend (real `/chat` route via
`supertest`, mocking only `optionalAuth`/`processWithGemini`/Supabase,
mirroring VTID-03926's established pattern exactly), 4 frontend
(source-level, mirroring VTID-04031/VTID-04205's `fnBody` pattern), 2
ownership-guard (real, unmocked `evaluateMarkerAuthorization()`).

Regression sweep — every test file exercising `runOperatorChatTurn()`'s
identity resolution, the reply meta shape, the cost badge, or the
ownership guard: `vtid-03926-operator-chat-userrole.test.ts`,
`vtid-04031-operator-turn-cost.test.ts`,
`scripts/command-hub-ownership-guard.test.ts`, `operator-chat-oasis.test.ts`,
`vtid-04028-operator-turn-stream.test.ts`,
`vtid-04102-operator-truncated-reply.test.ts`,
`vtid-04172-operator-simulated-tool-call-retry.test.ts`, plus the new file
— 8 suites, 76 tests, 0 failures.

## Not done here

- No live/Playwright screenshot — no deployed staging build carries this
  unmerged change; the change is a small, additive badge with no layout
  restructuring, verified at the source level per this repo's established
  pattern for this class of change (see VTID-04205's own acceptance note).
- Did not extend `/chat/stream`'s intermediate SSE frames
  (`turn.started`/`model.turn`/etc.) with this field — only the final
  `reply` frame (which is exactly `response.body`) carries it, since that
  is the frame the Command Hub actually renders a message row from.

OASIS_IMPACT: no — `authenticated` is a plain boolean on the existing
reply meta object; it emits no new OASIS events and changes no existing
event schema, topic, or authorization decision.
