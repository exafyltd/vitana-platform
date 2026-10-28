# VTID-05064 - Kiro Operator Console reliability

Owner approval 2026-10-10 (Gate 1: "very good. approved"). Sparring: `plan-sparring.md` (converged, 2 rounds).

VALIDATION_PROFILE: gateway_backend

No new route. `routes/operator.ts` changes the existing chat turn (thread row written at send; Kiro workspace events).

OASIS_PROOF: `operator.kiro.workspace_restored` (info) and `operator.kiro.parked_workspace_lost` (warning), payload `{ thread_id }` only, vtid VTID-05064, declared in the CicdEventType union (`types/cicd.ts`); emitted from `runKiroChatTurn` when a new Kiro session reopened the thread's parked workspace or started without the unpushed edits the last turn left.

## Acceptance criteria

AC-1: A kiro-runner session that ends with uncommitted edits keeps its workspace and the same thread's next session reopens it; clean workspaces are removed; parked ones expire (24 h), are capped (20), are removed on key revoke and are rescanned after a restart.
  TEST: services/kiro-runner/test/runner.test.ts
AC-2: The runner reports the workspace state before every prompt response and on reopen; the gateway keeps those frames out of the ACP stream and an older gateway ignores them.
  TEST: services/kiro-runner/test/runner.test.ts
  TEST: services/gateway/test/vtid-04999-kiro-runner-backend.test.ts
AC-3: A Kiro turn that ends with stopReason refusal is recorded as kiro_status refused (max_tokens / max_turn_requests / cancelled: incomplete), the reply is kept, and the console marks it "Kiro stopped early".
  TEST: services/gateway/test/vtid-04975-kiro-engine.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/command-hub/vtid-05064-operator-turn-thread.test.ts
AC-4: Restored history keeps the start and the end of long messages (cap 2,000 per message, 16,000 total), labels cut-off replies, and every new session's first prompt carries the operator rules (never ask the user for a VTID; check git status before describing progress).
  TEST: services/gateway/test/vtid-05018-kiro-thread-memory.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
AC-5: Lost unpushed edits are reported: reply meta kiro_workspace lost, OASIS operator.kiro.parked_workspace_lost, console notice.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-05018-kiro-thread-memory.test.ts
AC-6: The operator_threads row exists from the moment the message is sent (turns 0); recordOperatorTurn stays the only writer of messages.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
AC-7: The console saves a reply or error into the thread it was sent in, shows a banner in other threads and a spinner on the running thread, Stop targets the running thread, and every thread open merges typed and voice messages from the server.
  TEST: services/gateway/test/command-hub/vtid-05064-operator-turn-thread.test.ts
  UI: verified on staging after deploy (STAGING-VERIFY serves app.js/styles.css ?v=20261110-vtid-05064 with the new markers)
