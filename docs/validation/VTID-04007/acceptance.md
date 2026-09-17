# VTID-04007 — W2: open-ended intake — `autopilot_run_task(request)`

Context: `docs/OPERATOR-AGENT-BUILD-PLAN.md` W2. Test Run #4b (VTID-04012) proved the agent executor (W1) can find and edit a file it was never handed. The remaining intake gap: the Operator Console could only execute an already-named VTID with a pre-listed file set (`autopilot_execute_task`), i.e. the operator still had to do the discovery a Claude Code session does on its own. W0 shipped the server-side VTID self-allocation (`OPERATOR_VTID_SELF_ALLOCATE_ENABLED`, default OFF) without wiring a model-facing tool to it; this VTID wires that tool.

What the new tool does: `autopilot_run_task({ request, title? })` → authz (VTID-03851, exafy_admin session marker) → governance (`operator.autopilot.run_task`, A2) → `triggerOperatorExecution({ planMarkdown: request, filesReferenced: [], openEnded: true })` → VTID allocated + registered `in_progress`/`approved` with `metadata.intake='open_ended'` → recommendation + plan version with an empty file list → the unchanged safety gate (`approveAutoExecute`: kill switch, budget, depth; the file-level rules have nothing to judge yet) → execution row with `metadata.executor='agent'` pinned (independent of `OPERATOR_ONRAMP_EXECUTOR`) and the DeepSeek override → the agent runner switches its task prompt to discovery mode and the VTID-04006 post-hoc checks (allow/deny globs on the real diff, test-coverage rule, runner tsc + jest) apply.

AC-1 — Open-ended intake is refused when `OPERATOR_EXECUTION_ONRAMP_ENABLED` is off, and refused when `OPERATOR_VTID_SELF_ALLOCATE_ENABLED` is off (there is no VTID to fall back on); a non-open-ended call with no files is rejected exactly as before.
TEST: services/gateway/test/vtid-04007-open-ended-intake.test.ts

AC-2 — With both flags on: the VTID is allocated through `allocate_global_vtid` and registered with `intake:'open_ended'`; the recommendation's `spec_snapshot` carries `intake:'open_ended'` and an empty `files_referenced`; the execution row carries `executor:'agent'` + `intake:'open_ended'` even when `OPERATOR_ONRAMP_EXECUTOR` is unset; the OASIS `operator.execution_onramp.triggered` event carries `intake` and `vtid_allocated`. A pre-listed plan is unaffected.
TEST: services/gateway/test/vtid-04007-open-ended-intake.test.ts

AC-3 — The tool is declared in the tool registry and on the operator wire schema with `request` required and `title` optional, dispatched to `executeRunTask`, which refuses before governance for a non-admin thread and always passes an empty file list with `openEnded: true`.
TEST: services/gateway/test/vtid-04007-open-ended-intake.test.ts

AC-4 — Both operator prompt sources (served `PERSONALITY_DEFAULTS` and the inline fallback) list the tool, route open-ended requests to it, keep it apart from `autopilot_create_task`/`autopilot_execute_task`, and the CRITICAL EXECUTION RULES block stays byte-identical across the two (VTID-03838 drift rule).
TEST: services/gateway/test/vtid-04007-open-ended-intake.test.ts
TEST: services/gateway/test/vtid-03838-operator-prompt-lists-execute-tool.test.ts

AC-5 — The agent task prompt in discovery mode presents the request as the whole specification, gives no file list, instructs search-first discovery, forbids scope creep, and states the ambiguity rule; plan mode is unchanged.
TEST: services/gateway/test/vtid-04007-open-ended-intake.test.ts

Not verified here: a live open-ended request on staging (Test Run #5). `OPERATOR_VTID_SELF_ALLOCATE_ENABLED` is not set on `AWS-STAGE-DEPLOY-GATEWAY.yml` — the plan reserves that flip for the platform owner — so on staging the tool answers with the honest refusal from AC-1 until it is flipped.
