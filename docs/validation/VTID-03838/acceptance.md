# VTID-03838 — Operator system prompt lists `autopilot_execute_task`

## Report

VTID-03820 built the DeepSeek execution on-ramp and declared
`autopilot_execute_task` in `GEMINI_TOOL_DEFINITIONS` (the wire tool schema)
with a handler in `executeToolCall`. VTID-03828 then enabled
`OPERATOR_EXECUTION_ONRAMP_ENABLED=true` on staging and ran the first real
end-to-end test: a deliberately low-risk VTID (VTID-03829, "Gateway: add
task-title unit tests") pushed through the full spec pipeline to
`spec_status=approved`, then two real `POST /api/v1/operator/chat` calls
asking the Operator to execute it.

**Both calls failed to invoke the tool.** DeepSeek (`meta.provider:
"deepseek"`, `meta.model: "deepseek-flash"`) called only
`autopilot_get_status`, reasoned that ledger `status: in_progress` meant an
execution was "already running", and on the second, explicit attempt stated
*"that tool isn't available to me — the only autopilot capability I have
here is `autopilot_get_status`."*

Root cause, verified rather than assumed:

1. **The tool WAS on the wire.** `getRouterToolDefinitions()` maps every
   non-`dev_` declaration and `deepseekAdapter` forwards `tools[]` to
   `api.deepseek.com` unmodified (`llm-router.ts` L709-716) — no cap, no
   filter. VTID-03820's commit `d360473` is an ancestor of the staging
   build (`35ca6aed`, confirmed via `/api/v1/admin/build-info`).
2. **The tool was NOT in the prompt.** The served operator system prompt —
   `PERSONALITY_DEFAULTS.operator_chat.system_prompt`
   (`ai-personality-service.ts` L218; `getPersonalityConfigSync` returns it
   verbatim, and VTID-03817 already confirmed there is no live DB override)
   — carries an explicit **"Available tools"** list of five tools and a
   **"When to use tools"** routing table. `autopilot_execute_task` appears
   in neither. The inline fallback in `getOperatorSystemPrompt()`
   (`gemini-operator.ts`) has the same gap. The model answered from the
   prompt's list, not the schema — exactly what it said.
3. **OASIS confirms no execution attempt.** For the two turns
   (2026-09-12 21:00:38 and 21:01:19 UTC, thread
   `300fe2c1-266d-4669-b199-dba9574bd40f`) `oasis_events` records
   `operator.chat.message` → `autopilot.status.requested` →
   `assistant.turn: Tool call: autopilot_get_status` → reply. There is **no**
   `governance.evaluate` for `operator.autopilot.execute_task`, which
   `executeExecuteTask()` emits unconditionally on entry — so it never ran.

Fix: add the tool to both prompt sources (the served copy and the inline
fallback, kept byte-identical by a test) under "Available tools" and "When
to use tools", plus a **CRITICAL EXECUTION RULES** block that (a) restricts
the tool to an explicitly named VTID, never speculative, never for new
work; (b) states that a ledger status of `in_progress` is NOT a running
execution and must not be a reason to refuse; (c) requires
`files_referenced` to include test files (the safety gate rejects plans
without them); (d) requires honest reporting of any rejection and forbids
claiming "queued" unless the tool said so; (e) addresses the exact observed
failure — if the model believes the tool is unavailable, it must call it
and report the result rather than assert unavailability. Prompt-only
change; no runtime, routing, gate or flag behaviour changes.

## Acceptance Criteria

AC-1 — The served operator prompt (`PERSONALITY_DEFAULTS.operator_chat.system_prompt`)
lists `autopilot_execute_task` under "Available tools" and routes explicit
execution requests to it under "When to use tools".

TEST: `test/vtid-03838-operator-prompt-lists-execute-tool.test.ts` —
"PERSONALITY_DEFAULTS… › lists autopilot_execute_task under Available tools"
and "… › routes explicit execution requests to autopilot_execute_task".

AC-2 — The inline fallback prompt in `getOperatorSystemPrompt()` carries the
same additions, and its CRITICAL EXECUTION RULES block is byte-identical to
the served copy (after JS-string unescaping), so the two cannot drift.

TEST: same file — "getOperatorSystemPrompt() inline fallback › …" (5 tests)
and "the two prompt sources carry the same execution-rules block (no drift)".

AC-3 — The prompt explicitly tells the model that ledger `in_progress` is not
a running execution and must not cause a refusal, and that if it believes
the tool is unavailable it must call it and report the result — the two
behaviours observed live.

TEST: same file — "tells the model a ledger status of in_progress is not a
running execution" and "forbids the exact failure observed live".

AC-4 — Guardrails are present: named VTID only, never speculative, never for
creating work, honest on rejection, never claim "queued" unless returned.

TEST: same file — "keeps the guardrails: named VTID only, never speculative,
honest on rejection".

AC-5 — No regression: `tsc --noEmit` clean; operator/personality/on-ramp
scoped suites green; full gateway suite green.

TEST: `outputs/tsc-noemit.txt` (exit 0); `outputs/jest-scoped-operator.txt`
(10/10 suites, 103 passed, 2 pre-existing skipped);
`outputs/jest-full-suite-tail.txt`.

## Not verified here — the next real signal

The fix is verified structurally (the prompt now says what it needs to say)
and by regression. **It is not yet verified against a live DeepSeek turn.**
The next step, after this merges and `AWS-STAGE-DEPLOY-GATEWAY.yml`
redeploys staging, is to repeat the exact real test: one
`POST /api/v1/operator/chat` on staging asking to execute the
already-approved VTID-03829, and confirm in `oasis_events` that
`governance.evaluate` for `operator.autopilot.execute_task` fires and the
tool returns either `status: "queued"` (a real `dev_autopilot_executions`
row) or a specific safety-gate rejection — both are informative outcomes.
If DeepSeek still declines with the tool listed, that becomes a
model-compliance finding, not a prompt gap, and the remedy this repo has
used for that class (VTID-03650/03824: a deterministic code backstop, e.g.
a `forceTool` on messages that name a VTID and an execute verb) is the next
VTID, not more prompt wording.
