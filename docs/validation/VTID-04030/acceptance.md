# VTID-04030 — W4f: review / approve / reject a held Dev Autopilot execution from the Operator Console (gap analysis §4.6)

Context: VTID-04029 (W4e) made the agent executor hold before opening its pull request (status `awaiting_approval`, a bounded diff preview on the row, `GET /executions/:id/diff`, `POST …/approve`, `POST …/reject`) — but the only place a human could act on it was the Command Hub's Autopilot Live rows. The Operator Console, which is where the execution was asked for in the first place (`autopilot_run_task` / `autopilot_execute_task`), could neither show what was waiting nor take the decision. This VTID closes that loop with three operator tools over the same VTID-04029 functions, so the whole cycle — ask, wait, review the diff, decide — can happen in one chat.

What ships:

- `services/gateway/src/services/operator-approval-tools.ts`:
  - `autopilot_review_execution(execution_id?)` — read-only. With no id: every execution currently `awaiting_approval` (newest first, bounded to 20) with its VTID (resolved through the finding's `activated_vtid`, one batched read, fails open), branch, PR title, `staged_at`, file/patch totals. With an id: the stored preview bounded for the model — PR title, body (≤ 2 000 chars), files (≤ 60, total reported), `--stat`, unified diff (≤ 12 000 chars, `patch_truncated` reported), base/head SHAs. A row that is no longer held is reported by status, never as a preview.
  - `autopilot_approve_execution(execution_id)` → `approveExecution` (VTID-04029): opens the PR on the pushed branch with the stored title/body, row → `ci`; the result carries `pr_url`/`pr_number`. A refusal (not `awaiting_approval`, no preview, PR-open failure) is passed through verbatim and never reported as success.
  - `autopilot_reject_execution(execution_id, reason?)` → `rejectExecution`: branch deleted best effort, row → `cancelled`, the trimmed reason (≤ 500 chars) recorded.
  - The execution id may be the full UUID or the 8+ character prefix the Command Hub / earlier tool results show; a prefix resolves ONLY among rows currently awaiting approval and must match exactly one (none / ambiguous / too short are named refusals — the model is told to list and ask, never guess).
- **Caller gate:** every handler runs the VTID-03851 check first (`isExecuteTaskAuthorized(getThreadAuth(threadId))`) — an anonymous or non-admin chat turn is refused, naming the tool, before Supabase is touched; the actor recorded on the row and on the VTID-04029 OASIS events is derived from the verified identity (`operator-chat:<user_id>`), never from the model's arguments.
- **Wiring:** tool registry (3 entries, `VTID-04030`, `allowed_roles` operator/admin/developer, Supabase-health list), operator wire schema (same shapes, review's `execution_id` optional), dispatch cases, and BOTH prompt sources (served `PERSONALITY_DEFAULTS.operator_chat` and the inline fallback — the VTID-03838 drift rule: the execution-rules block stays byte-identical). The prompt routes "what is waiting for my approval / show me the diff of …" to review and only an explicit named decision to approve/reject, and forbids approving or rejecting on the model's own judgement of the diff.
- No new OASIS topic, no schema, flag, secret, workflow or task-def change: approve/reject emit the VTID-04029 `dev_autopilot.execution.approved` / `.rejected` events through the functions they call.

AC-1 — Declarations: registry entries (review optional id, approve/reject required id, reject optional reason, all `VTID-04030`), operator wire schema in order and each case dispatched to its handler, the import in `gemini-operator.ts`.
TEST: services/gateway/test/vtid-04030-operator-approval-tools.test.ts

AC-2 — Both prompt sources list the three tools, route review vs decision, state that the tools never start work and forbid deciding on the model's own judgement; the execution-rules block is byte-identical across both sources (VTID-03838), and the VTID-04007 / VTID-03838 suites still pass.
TEST: services/gateway/test/vtid-04030-operator-approval-tools.test.ts
TEST: services/gateway/test/vtid-04007-open-ended-intake.test.ts
TEST: services/gateway/test/vtid-03838-operator-prompt-lists-execute-tool.test.ts

AC-3 — Caller gate: anonymous and non-admin threads are refused for all three tools, naming the tool, with no Supabase call; the actor is `operator-chat:<verified user_id>`; an unconfigured Supabase is an error, not a throw.
TEST: services/gateway/test/vtid-04030-operator-approval-tools.test.ts
TEST: services/gateway/test/vtid-03851-execute-task-requires-auth.test.ts

AC-4 — `resolveExecutionId`: a full UUID needs no lookup; a prefix resolves only among `awaiting_approval` rows and only when unique; none / ambiguous / shorter than 6 hex chars / non-hex are named refusals.
TEST: services/gateway/test/vtid-04030-operator-approval-tools.test.ts

AC-5 — Review: no id → the bounded waiting list with VTIDs from the finding and a "nothing waiting" message when empty; an id → the preview bounded (patch 12 000, body 2 000, files 60, totals and truncation reported); a row not held → its status, no preview; a missing row → the VTID-04029 error.
TEST: services/gateway/test/vtid-04030-operator-approval-tools.test.ts

AC-6 — Approve / reject hand the resolved id and the verified actor (and the trimmed reason) to the VTID-04029 functions, report PR / branch outcome on success and pass refusals through as errors; the VTID-04029 suite is unchanged.
TEST: services/gateway/test/vtid-04030-operator-approval-tools.test.ts
TEST: services/gateway/test/vtid-04029-dev-autopilot-pr-approval.test.ts

OASIS_PROOF: no OASIS topic, payload or consumer change — the tools call `approveExecution` / `rejectExecution`, which emit the VTID-04029 `dev_autopilot.execution.approved` / `.rejected` events exactly as the Command Hub routes do (same functions), with the actor string `operator-chat:<user_id>` in the existing `actor` field. Review is read-only and emits nothing.

Not verified here: a real held execution reviewed and approved from the Operator Console on staging — that needs `OPERATOR_PR_APPROVAL_REQUIRED=true` on the staging gateway (owner pin) and the executor image rebuilt from VTID-04029 (owner dispatch); the first chat-driven Approve is the Test Run #7 variant for this VTID. No UI change (the Command Hub buttons from VTID-04029 stay as they are). Still open from §4.6: cost/model badge, cancel of a running agent.
