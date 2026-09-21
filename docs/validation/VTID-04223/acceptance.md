# VTID-04223 — Engineering memory for the agent executor

## Gap (docs/AGENT-REGISTRY.md, row 2)

The agent executor (`services/gateway/src/services/autopilot-agent/`) started
every run knowing only its plan, the CLAUDE.md Part 1 excerpt from its clone
and the static conventions block. No service map, no schema index, no open
PRs, no `dev_agent_memory` recall, and no record of what attempt N-1 on the
same finding tried — a fix-mode retry re-read the CI evidence and nothing
else. At the end of a run nothing was extracted from the transcript; only the
gateway's `applyExecutionResult` wrote a task_outcome/gotcha row.

## Fix

New `autopilot-agent/agent-memory-context.ts`:

- **In:** (a) the W4a session bootstrap pack, REUSED through
  `buildBootstrapSections(defaultBootstrapDeps())` — same fetchers, same
  renderers; the governance-rules section is dropped (the clone's CLAUDE.md
  already covers it) and the pack header is rewritten to name the executor's
  own tools; (b) top-10 category-diverse `dev_agent_memory` recall
  (`dev-memory-ranking.ts`) against VTID + plan + prior failure; (c) the
  finding's prior `agent_runs[]` (VTID-04017) rendered newest-first with the
  current execution excluded. Each source is timed out (8 s) and fails open;
  the whole block is capped at 30 KB and appended to the agent system prompt.
- **Out:** ≤3 durable facts extracted from the run transcript (tail-bounded)
  through the shared VTID-04025 extractor on the `memory` routing stage,
  written with executor provenance/tags/source. The console gate
  `OPERATOR_TURN_MEMORY_ENABLED` is forced open for that one call — the
  executor task carries no OPERATOR_* flags; `AGENT_MEMORY_CONTEXT_ENABLED`
  (default on, exact `false` off) is the executor's switch.
- Runner emits `runner:memory_context` (stats in the OASIS payload) before
  the loop and `runner:memory_record` in `finally`.
- `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` pins `AGENT_MEMORY_CONTEXT_ENABLED`
  and `OPERATOR_BOOTSTRAP_BUILD_INFO_URLS` on the executor task definition.

## Acceptance Criteria

AC-1 — The flag is on by default and off only on the exact string `false`; disabled means no source is touched.
TEST: services/gateway/test/vtid-04223-agent-memory-context.test.ts — "is on by default…", "disabled → empty, no source touched".

AC-2 — The memory block assembles prior runs, recall and bootstrap under one header, drops the bootstrap governance-rules section, rewrites the pack header to the executor's tools, and is capped at 30 KB.
TEST: services/gateway/test/vtid-04223-agent-memory-context.test.ts — "assembles all three sources…", "assembles prior runs, then recall, then bootstrap…".

AC-3 — Every source fails open: one failing or hung source never drops the others, its error is named in the stats, and all sources failing yields an empty block without throwing.
TEST: services/gateway/test/vtid-04223-agent-memory-context.test.ts — "one failing source never drops the others", "a hung source is bounded by the timeout", "all sources failing yields an empty block".

AC-4 — Prior runs render newest first, exclude the current execution, cap rows and clip the error.
TEST: services/gateway/test/vtid-04223-agent-memory-context.test.ts — "prior runs: newest first…".

AC-5 — End of run: facts are extracted through the shared extractor and written with `source:'autopilot'`, executor tags and executor provenance; disabled / empty transcript / extractor failure never throw.
TEST: services/gateway/test/vtid-04223-agent-memory-context.test.ts — the "recordAgentRunMemory" block; services/gateway/test/vtid-04025-operator-turn-memory.test.ts (console shape unchanged).

AC-6 — The agent system prompt appends the block after the governance rules and omits it when empty; the runner builds it before the loop, emits `runner:memory_context`, and records memory in `finally`.
TEST: services/gateway/test/vtid-04223-agent-memory-context.test.ts — "prompt + runner wiring (source contract)".

AC-7 — The executor workflow pins `AGENT_MEMORY_CONTEXT_ENABLED=true` and the build-info targets on the task definition.
TEST: services/gateway/test/vtid-04223-agent-memory-context.test.ts — "the executor workflow pins…"; services/gateway/test/vtid-03850-staging-executor-dispatch-pinned.test.ts.

AC-8 — Live (staging): a real agent execution on the rebuilt image emits `runner:memory_context` with `chars > 0`, `bootstrap_sections > 0` and at least one recalled row, and `runner:memory_record` with `written ≥ 0`.
TEST: docs/validation/VTID-04223/outputs/ — recorded after the executor image rebuild; NOT verified at PR time (stated in the PR).

## Not verified at PR time

- The live staging run (AC-8). The executor image must be rebuilt from the
  merge (`AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` dispatch) before any run
  carries this code; the first `autopilot_run_task` after that is the exercise.
- Recall quality: the block is injected, but whether a recalled row changes
  a decision is only observable in a real transcript.

OASIS_PROOF: not applicable — no new OASIS topic; `runner:memory_context` /
`runner:memory_record` are steps on the existing `dev_autopilot.agent.tool`
topic (payload gains `data`).
