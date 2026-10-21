# VTID-04034 — W4j: cancel a queued or running Dev Autopilot execution from the Operator Console

Context: W4h (VTID-04032) made a cancel real — `POST /api/v1/dev-autopilot/executions/:id/cancel` now stops a `running` agent (row marked `cancelled` at once, ECS `StopTask` best effort, the agent halts at its next turn boundary through its heartbeat read-back) — and put `Cancel run` on the Autopilot Live rows. Its acceptance record named the one thing left out: an operator-chat tool, "the same VTID-04030 gate pattern would apply". With W4i (VTID-04033) the console now shows the agent's steps under the reply that queued it, so "stop that, wrong file" is exactly where the operator is when they decide. This VTID adds the tool.

What ships:

- `services/gateway/src/services/operator-cancel-tool.ts`:
  - `autopilot_cancel_execution(execution_id?, reason?)` — with NO id: the executions that can be cancelled right now (`status in (cooling, running)`, newest first, ≤ 20) with VTID, executor, claimed env, branch, timestamps and the ECS task id when the row remembers one — read-only, nothing cancelled, the message says so. With an id: VTID-04032's `cancelExecution(id, { actor, reason })` — a cooling row is cancelled at once; a running row is marked cancelled, its ECS task stopped best effort and the agent stops itself at its next turn boundary. The reply says which of those happened (`was`, `ecs_task_stopped`, `ecs_task_error` verbatim when StopTask was refused) and that nothing will be pushed or opened.
  - Ids may be the full UUID or the 8+ character prefix operators see; a prefix resolves ONLY among cancellable rows and must match exactly one (none / ambiguous / too short / non-hex are named refusals — the model is told to list and ask, never guess). A refusal from `cancelExecution` (wrong status, missing row) is passed through as an error, never reported as success.
  - **Caller gate:** the VTID-03851 check (`authorizeApprovalTool`, reused from VTID-04030) runs before any Supabase read — an anonymous or non-admin chat turn is refused naming the tool; the actor written on the row (`metadata.cancelled.by`) and on the `dev_autopilot.execution.cancelled` event is `operator-chat:<verified user_id>`, never a model argument. The reason is the user's words, trimmed to 500 chars.
- **Wiring:** tool registry (`VTID-04034`, optional id + reason, operator/admin/developer, Supabase-health list), operator wire schema (after reject, before get_status), dispatch case, and BOTH prompt sources (served `PERSONALITY_DEFAULTS.operator_chat` and the inline fallback — the VTID-03838 drift rule: the execution-rules block stays byte-identical). The prompt routes "cancel/stop/abort … / what is running that I can cancel?" to the tool, tells the model a held execution is reject's business, and forbids cancelling on its own judgement.
- No new OASIS topic, no schema, flag, secret, workflow, task-def, route or UI change: the tool calls the VTID-04032 function the Command Hub route calls, which emits the existing `dev_autopilot.execution.cancelled` event.

AC-1 — Declaration: registry entry (optional `execution_id` + `reason`, `VTID-04034`, roles, health list), wire schema position and shape, dispatch to `executeCancelExecution`, the import.
TEST: services/gateway/test/vtid-04034-operator-cancel-tool.test.ts

AC-2 — Both prompt sources list the tool, route stop/cancel requests to it (no id to list, the named id to cancel), distinguish it from reject, and forbid cancelling on the model's own judgement; the execution-rules block is byte-identical across both sources (VTID-03838), and the VTID-04007 / VTID-03838 / VTID-04030 suites still pass.
TEST: services/gateway/test/vtid-04034-operator-cancel-tool.test.ts
TEST: services/gateway/test/vtid-04007-open-ended-intake.test.ts
TEST: services/gateway/test/vtid-03838-operator-prompt-lists-execute-tool.test.ts
TEST: services/gateway/test/vtid-04030-operator-approval-tools.test.ts

AC-3 — Caller gate: anonymous and non-admin threads are refused naming the tool, with no Supabase call and no cancel; an unconfigured Supabase is an error, not a throw.
TEST: services/gateway/test/vtid-04034-operator-cancel-tool.test.ts
TEST: services/gateway/test/vtid-03851-execute-task-requires-auth.test.ts

AC-4 — Id resolution: a full UUID needs no lookup; a prefix resolves only among `cooling`/`running` rows and only when unique; none / ambiguous / shorter than 6 hex chars / non-hex are named refusals; the listing queries exactly those statuses, newest first, bounded.
TEST: services/gateway/test/vtid-04034-operator-cancel-tool.test.ts

AC-5 — Execute: no id → the read-only list (and a "nothing to cancel" message when empty), `cancelExecution` never called; an id → `cancelExecution` receives the resolved id, `operator-chat:<user_id>` and the trimmed reason; the reply reports a stopped task, a refused StopTask (error verbatim + the cooperative stop), or a plain cooling cancel; a `cancelExecution` refusal is passed through as an error. The VTID-04032 suite is unchanged.
TEST: services/gateway/test/vtid-04034-operator-cancel-tool.test.ts
TEST: services/gateway/test/vtid-04032-cancel-running-execution.test.ts

OASIS_PROOF: no OASIS topic, payload or consumer change — the tool calls `cancelExecution` (VTID-04032), which emits `dev_autopilot.execution.cancelled` exactly as the Command Hub route does, with the actor string `operator-chat:<user_id>` in the existing `actor` field. The no-id listing is read-only and emits nothing.

Not verified here: a real cancel from the staging console — the first one is the exercise, and (as with VTID-04032's button) it answers the `ecs:StopTask` permission question by itself; a denial lands verbatim in the tool's reply and on the row, and the run still stops on its next heartbeat. No UI change (the VTID-04033 follow panel shows the `cancelled` terminal outcome when the stream closes).
