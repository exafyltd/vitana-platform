# VTID-04195 — Acceptance

## Context

Part of the platform owner's 30-task Command Hub batch executed through
the Operator Console's Dev Autopilot on-ramp. Two of the batch's real,
terminal failures were investigated read-only via `oasis_events` and
`vtid_ledger`:

- **VTID-04141** ("No executions found" empty state for the Dev Autopilot
  execution list) hit the agent's 120-turn cap. All of turns 116-120
  (and, from the pattern, most of the run before that) were `search_text`
  calls hunting for the right render function inside
  `command-hub/app.js` — 55K+ lines, no build step. The run never called
  `finish`; no edit, no PR.
- **VTID-04139** (loading skeleton for the Autopilot Live view) died at
  turn 112 after 3 consecutive text-only completions each hitting the
  8000-token output cap (`MAX_CONSECUTIVE_NUDGES` in `agent-loop.ts`),
  with `input_tokens` around 92K — consistent with the same navigation
  cost inflating context size until the model's reasoning alone consumed
  its whole output budget.

VTID-04085 (PR #3440, separate) built `specs/command-hub-symbol-index.json`
— a function-name → line-range index for exactly these 11 files — but
nothing told the agent it exists. Grepped `src/` for any reference to
`command-hub-symbol-index` outside the generator/test: zero hits. The
index alone cannot help a run that never knows to read it.

## Root cause

`context-loader.ts`'s `CONVENTIONS` string (injected into every agent
system prompt via `buildAgentSystemPrompt`, `run-agent-execution.ts`
line 204) had no mention of the symbol index or any Command-Hub-specific
navigation guidance at all — the agent's only documented strategy for any
file is "search_text / find_files ... before editing" (step 1 of "How to
work" in `agent-prompt.ts`), which is exactly the blind-sweep pattern that
burned VTID-04141's whole turn budget.

## Fix

Added a `## Command Hub navigation` section to `CONVENTIONS`, between the
antipattern table and "When in doubt", instructing the agent to read
`specs/command-hub-symbol-index.json` before searching the 11
`command-hub/*.js` files, look up a plausible function name there, and
`read_file` only its line range — falling back to `search_text` only for
a name the index doesn't have. Also notes the index can go stale and asks
the agent to flag a rename/add/delete of one of these functions in the PR
body.

This does not touch `agent-loop.ts`, `agent-tools.ts`, or the safety
gate — it is a prompt-content change only, in the one file already
injected into both the single-shot and agent-executor prompts.

## Acceptance Criteria

AC-1: `loadAutopilotContext()` includes a `## Command Hub navigation`
section naming both the index file path and the generator script path.
TEST: `test/services/dev-autopilot/context-loader.test.ts` — "includes
the Command Hub symbol-index navigation section (VTID-04195)".

AC-2: the new section appears before "## When in doubt" (so a reader
sees navigation guidance before the generic fallback advice, matching the
document's existing top-to-bottom reading order).
TEST: same file — "places the Command Hub navigation section before
\"When in doubt\" (VTID-04195)".

AC-3: no regression to the pre-existing conventions/imports-surface
content, ordering, caching, or logging behaviour.
TEST: same file — all 10 pre-existing tests re-run unmodified and pass.

AC-4: `tsc --noEmit` stays clean — this is a plain string-literal edit
inside an existing template string, no type surface changed.
TEST: `npx tsc --noEmit` (see commands.log).
