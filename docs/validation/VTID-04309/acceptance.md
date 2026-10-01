# VTID-04309 — Command Hub voice turns land in the Operator Console thread (+ VTID-04310 voice → Operator)

Steps 3 and 4 of `docs/INTAKE-CHANNELS-PLAN.md` (VTID-04306). Companion VTID
in this PR: VTID-04310 (voice delegation tool + Command Hub voice catalog).

## Why

- The Command Hub voice assistant wrote every turn into the member's
  community "Vitana" inbox DM (VTID-CHAT-BRIDGE) and never into the Operator
  Console, so there was no single place to scroll back through a developer
  conversation.
- The Operator Console never sent its thread id: 144 of 152 live
  `operator_threads` rows had exactly one turn, so server-side threads and
  rolling summaries (VTID-04022) never accrued.
- Voice could not start work through the Operator on-ramp. Its task tools
  (`dev_create_task`, `dev_execute_vtid`, …) called `/api/v1/vtid/create` and
  the worker orchestrator directly, with no auth header, outside the approval
  hold — and were appended last to a ~290-declaration catalog the byte budget
  very likely trimmed away.

## Acceptance Criteria

AC-1 A voice session started from `/command-hub*` with a UUID `operator_thread_id` is bound to that thread; any other surface or a non-UUID value binds nothing.
TEST: services/gateway/test/vtid-04309-command-hub-voice-thread.test.ts

AC-2 Each finished Command Hub voice turn is recorded into the bound thread (`meta.channel='voice'`) and is never bridged into the community inbox; community sessions are unchanged. Empty user/assistant sides (greeting turn) are not written.
TEST: services/gateway/test/vtid-04309-command-hub-voice-thread.test.ts

AC-3 `GET /api/v1/operator/threads/:threadId/messages` returns the thread's messages (optionally `?since=`) to its owner only, exafy_admin required; another owner's thread reads as 404.
TEST: services/gateway/test/vtid-04309-thread-messages-route.test.ts

AC-4 The Operator Console sends its thread id on every chat turn, binds the voice widget to the active thread, and merges voice turns into the transcript with a visible voice label.
TEST: services/gateway/test/vtid-04309-command-hub-voice-thread.test.ts

AC-5 The Command Hub voice catalog declares `operator_delegate` once, drops community tools and the legacy lifecycle task tools, keeps navigation / memory / developer read tools, and fits under the 64 KB budget; the community catalog is unchanged.
TEST: services/gateway/test/vtid-04310-command-hub-voice-operator-delegate.test.ts

AC-6 `operator_delegate` runs the Operator turn on the bound thread with the voice session's verified identity (tag `voice_delegate`), returns a bounded summary with any queued executions, reports `still_working` when the turn outlasts the wait, and refuses outside the Command Hub or without a signed-in identity.
TEST: services/gateway/test/vtid-04310-command-hub-voice-operator-delegate.test.ts

AC-7 The developer persona's voice tool instructions name `operator_delegate` as intent, with no scripted spoken line (NEVER rule 41).
TEST: services/gateway/test/orb/live/characterization/system-instruction.characterization.test.ts

## Route evidence

ROUTE_MOUNT: `router.get('/threads/:threadId/messages', requireAdminAuth, …)` in `services/gateway/src/routes/operator.ts`; the operator router is mounted at `/api/v1/operator` in `services/gateway/src/index.ts` (unchanged).
FINAL_URL: `GET /api/v1/operator/threads/:threadId/messages`
CURL_PROOF: against the real app (`import app from '../src/index'`, supertest) — no token → `401 application/json {"ok":false,"error":"UNAUTHENTICATED"}`; forged token → `401 application/json`. The route exists (JSON, not an Express HTML 404). A live staging curl is the post-deploy check: expect `401 application/json` without a token. Output: `outputs/jest.txt`.

## Visual check

`outputs/voice-tags-desktop.png` (1400×900) and `outputs/voice-tags-mobile.png` (390×844): the real `styles.css` rendering the four voice-tagged bubble kinds next to plain chat bubbles. Labels readable, no overflow at phone width. Rendered from a static page with the same DOM classes, not the full Command Hub app.

## Not verified here

- No live Command Hub voice session was run: this session has no microphone
  and cannot drive a real voice turn. The first developer voice session on
  staging after deploy is the exercise — expect `operator_messages` rows with
  `meta.channel='voice'` under the console thread, and no new community inbox
  rows for that session.
- `operator_delegate` queuing a real execution needs an exafy_admin voice
  session; the delegated turn goes through the unchanged VTID-03851 gate and
  the approval hold.
