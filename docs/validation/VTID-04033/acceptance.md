# VTID-04033 — W4i: the Operator Console follows a Dev Autopilot execution it queued (gap analysis §4.6 follow-through, §3.10)

Context: since W2 (`autopilot_run_task`, VTID-04007) and W4f (`autopilot_approve_execution`, VTID-04030) a console turn can queue or approve a Dev Autopilot execution — and the reply ends with "it will run on the next executor tick". From there the console went quiet: to learn whether the agent had been claimed, what it was doing, or that it had parked for approval, the operator had to open Autopilot Live and find the row. The reply's tool results already carried the `execution_id`, and VTID-03897's per-execution SSE tail (`GET /api/v1/dev-autopilot/executions/:id/stream`, `connected → step* → terminal`) already served the Live view — so this is a client-only change.

What ships (all in `services/gateway/src/frontend/command-hub/`):

- `extractFollowedExecutionIds(toolResults)` — the successful results of `autopilot_run_task` / `autopilot_execute_task` / `autopilot_approve_execution` that carry an `execution_id`, in order, deduplicated; review results, failed results (`ok:false`) and results without an id never follow.
- `followOperatorExecution(execId, tool)` — one `EventSource` per execution on the VTID-03897 stream (bearer as `access_token` query, the same contract the Live view uses because the browser's `EventSource` cannot set a header); `step` frames appended and bounded to the last `OPERATOR_EXEC_FOLLOW_MAX_LINES` (40); the `terminal` frame records its topic and closes the stream; a stream error is shown, not thrown; an already-open or already-terminal slot is never reopened. `closeOperatorExecutionFollow` / `closeAllOperatorExecutionFollows` — the latter runs on a new thread.
- `renderOperatorExecutionFollow(execId)` — the panel under the reply: a chip linking to `/command-hub/autopilot/live/#autopilot-live-exec-<id>`, a status marker (`queued · following` / `approved · following` pulsing while live; the terminal outcome — `held for approval`, `completed`, `failed`, `cancelled`, `reverted`, `rejected`, `archived` — when done; `stream reconnecting…` or the browser error otherwise), and the step lines through `describeFollowedStep` (`turn N · agent.tool: …`; `status:'error'` / `metadata.is_error` red, `status:'success'` green).
- `sendChatMessage` stamps `followExecIds` on the reply it pushes and opens a follow for each; `renderOperatorChat` renders the panels after the tool-activity lines. State: `state.operatorExecFollow`.
- Styles (`.chat-exec-follow*`, classes only — CSP added-lines gate re-run clean), cache-bust `20260918-vtid-04033-exec-follow`, VTID-04033 in `scripts/ci/command-hub-ownership-guard.js`'s allowlist.
- Found on the way: the VTID-04031 and VTID-04032 suites pinned the exact cache-bust string, so any later Command Hub bump would fail them — both relaxed to the at-or-after form VTID-04028 uses (the VTID-04031 fix folded into the still-unpushed W4h commit so its own PR is green; the VTID-04032 fix rides here).
- No gateway change, no route, no OASIS change, no flag.

AC-1 — `extractFollowedExecutionIds`: successful queue/approve results with an id are followed in order and deduplicated; review results, failed results, missing/blank ids, a non-array and null entries are ignored.
TEST: services/gateway/test/vtid-04033-operator-execution-follow.test.ts

AC-2 — `describeFollowedStep`: execution topics render short, agent steps carry `turn N` and the tool, missing fields are tolerated; every terminal topic in the route's `EXECUTION_STREAM_TERMINAL_TOPICS` has a label (asserted against the route source, so a new terminal topic fails this test until labelled).
TEST: services/gateway/test/vtid-04033-operator-execution-follow.test.ts

AC-3 — Follow lifecycle: the stream URL and bearer-as-query contract, the step bound, close on `terminal`, no reopen of an open/terminal slot, close-all on a new thread, follow state on the console state.
TEST: services/gateway/test/vtid-04033-operator-execution-follow.test.ts

AC-4 — Wiring and rendering: `sendChatMessage` stamps `followExecIds` and follows each; `renderOperatorChat` renders the panel; the panel uses the chip href, the three status classes and the failed-line class, and no inline style; styles, cache-bust and the ownership-guard allowlist ship together. The W4d / W4g / W4h / VTID-03947 / VTID-03822 / VTID-03949 console suites still pass.
TEST: services/gateway/test/vtid-04033-operator-execution-follow.test.ts
TEST: services/gateway/test/vtid-04028-operator-turn-stream.test.ts
TEST: services/gateway/test/vtid-04031-operator-turn-cost.test.ts
TEST: services/gateway/test/vtid-04032-cancel-running-execution.test.ts
TEST: services/gateway/test/vtid-03947-message-copy-timestamp.test.ts

OASIS_PROOF: no OASIS change — the panel consumes the `dev_autopilot.*` rows VTID-03897's stream already serves and the terminal set VTID-04029 last widened; nothing is emitted by the client.

Visual verification (CLAUDE.md IF-THEN 26): local harness (`outputs/harness-server.js` — statics from the working tree, stubbed boot APIs, a scripted `/chat/stream` turn whose reply carries one successful `autopilot_run_task` result, and a scripted `/executions/:id/stream` emitting seven steps then the `awaiting_approval` terminal frame; nothing live) driven by Playwright (`outputs/harness-shoot.js`). `outputs/exec-follow-live-desktop.png` (1400×900): under the reply, the chip `execution 9a4d2c7e`, the amber `queued · following` marker and the first three steps; `outputs/exec-follow-done-desktop.png`: the marker reads `held for approval`, the failed check line red, the passing one green, the stream closed (`state.operatorExecFollow[*].es === null`, asserted in the run log). The 390×844 captures show the same panel in the pre-existing VTID-03949 narrow chat column.

Not verified here: a real followed execution on staging — the next `autopilot_run_task` from the staging console after this deploys is the exercise (it depends on nothing the owner has to pin; the stream route is already live). Deliberately not done: polling `/executions` for the row status (the terminal frame is the status), and Approve / Reject on the panel (the VTID-04030 chat tools and the VTID-04029 Live buttons already do; a third copy would drift).
