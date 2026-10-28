# VTID-03845 — Operator prompt: `files_referenced` wording for test-only plans

## Report

The operator system prompt's CRITICAL EXECUTION RULES block (served copy in
`PERSONALITY_DEFAULTS.operator_chat.system_prompt`,
`ai-personality-service.ts`; inline fallback in `getOperatorSystemPrompt()`,
`gemini-operator.ts`) told the model: "list in files_referenced the source
file(s) to change AND their test file(s) — the safety gate rejects a plan
without test coverage." The tool-list line and the `autopilot_execute_task`
JSON-schema description said the same ("BOTH the source file(s) being changed
AND their paired test file(s)").

For a test-only plan that wording has no honest reading: the model complied
by listing a source file the plan did not touch. Observed on staging
2026-09-13 during the VTID-03829 on-ramp test: `files_referenced` carried
`src/utils/task-title.ts` (the module under test, untouched) alongside the
new test file, and the safety gate rejected the plan with
`file_outside_allow_scope` because `src/utils/**` is not in the executor's
allow scope. The plan had to be re-sent with an explicit `## Files to
modify` section naming only the test file.

Fix: all three sources now say the same thing — `files_referenced` is the
files the plan will create or change, nothing else; a test-only plan lists
only the test file; a source change lists the source file AND its test file
(the test-coverage gate still binds); never add a file the plan does not
touch, because the gate also rejects any file outside its allow scope. The
execution-rules block stays byte-identical between the two prompt sources
(pinned by the existing VTID-03838 drift test).

## Acceptance Criteria

AC-1 — Both prompt sources carry the new rule: files the plan will create or
change; a test-only plan lists only the test file; never add an untouched
file.

TEST: `test/vtid-03838-operator-prompt-lists-execute-tool.test.ts` —
"files_referenced = the files the plan will create or change; a test-only
plan lists only the test file" (runs once per prompt source).

AC-2 — The old wording is gone from both sources (execution rule and the
tool-list parenthetical).

TEST: same test — the two `not.toMatch` assertions on the old phrases.

AC-3 — The execution-rules block remains byte-identical across the served
copy and the inline fallback.

TEST: same file — "the two prompt sources carry the same execution-rules
block (no drift)".

AC-4 — The tool declaration's `files_referenced` schema description matches
the prompt (the model reads both).

TEST: `outputs/tool-schema-description.txt` — grep of
`gemini-operator.ts` showing the updated description; no old phrase remains
anywhere under `services/gateway/src` (`outputs/old-wording-grep.txt`, empty).

AC-5 — No regression: `tsc --noEmit` clean; scoped suites green; full
gateway suite green.

TEST: `outputs/tsc-noemit.txt` (exit 0);
`outputs/jest-scoped-operator-prompt.txt`; `outputs/jest-full-suite-tail.txt`.

## Not verified here

Prompt wording is a model-compliance change, not a deterministic one. It is
verified structurally (the text the model receives) and against the exact
failure observed; whether DeepSeek now lists only the test file for a
test-only plan is confirmed by the next real on-ramp request on staging.
The safety gate itself is unchanged and still rejects an out-of-scope file
regardless of prompt wording.
