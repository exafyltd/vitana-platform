# VTID-04224 — Acceptance

dev_agent_memory: file-scoped recall + stage provenance (Phase 0/1 of a
larger plan to give the Planner/Worker/Validator LLM routing stages access
to the same cross-session engineering memory the Operator Console and Dev
Autopilot executor already use).

VALIDATION_PROFILE: gateway_backend

## Acceptance Criteria

AC-1: Every existing `write_dev_memory()` caller keeps compiling and posting
the exact same RPC body it always did (repo, category, title, content,
embedding, vtid, importance, source, tags, supersedes), with two new
trailing fields (`p_file_paths: []`, `p_stage: null`) appended by default
when the caller doesn't pass them — never a breaking change to the wire
shape.
TEST: services/gateway/test/services/dev-agent-memory.test.ts — `writeDevMemory`
  → "embeds title + content together and posts the exact write_dev_memory RPC shape"

AC-2: `writeDevMemory()` forwards an explicit `filePaths`/`stage` as
`p_file_paths`/`p_stage` when a caller supplies them.
TEST: services/gateway/test/services/dev-agent-memory.test.ts — `writeDevMemory — file_paths/stage passthrough`
  → "forwards filePaths/stage as p_file_paths/p_stage when given"

AC-3: `recallDevMemoryByFiles()` never calls the RPC and returns `ok:true`
with an empty hit list for an empty file list (an open-ended task with no
named files yet is a normal state, not a search failure).
TEST: services/gateway/test/services/dev-agent-memory.test.ts — `recallDevMemoryByFiles`
  → "never calls the RPC and returns ok:true with no hits for an empty file list"

AC-4: `recallDevMemoryByFiles()` posts the exact `recall_dev_memory_by_files`
RPC shape (`p_repo`, `p_files`, `p_category`, `p_limit`, defaulting
`limit` to 8 and `category` to null) and returns the hits verbatim.
TEST: services/gateway/test/services/dev-agent-memory.test.ts — `recallDevMemoryByFiles`
  → "posts the exact recall_dev_memory_by_files RPC shape and returns the hits verbatim"
  → "defaults limit to 8 and category to null when not specified"

AC-5: The Dev Autopilot executor's existing outcome writer
(`buildExecutionOutcomeMemory`) stamps `stage:'worker'` on both the
success (`task_outcome`) and failure (`gotcha`) rows it already writes, and
threads an optional `filePaths` list through — defaulting to `[]`, never
`undefined`, when a caller doesn't supply one.
TEST: services/gateway/test/vtid-04025-operator-turn-memory.test.ts —
  "a run that opened a PR becomes a task_outcome row; a failed run becomes a gotcha row carrying the reason"

AC-6: The migration is additive only — the new columns are nullable/defaulted,
`write_dev_memory()`'s existing 10-parameter call shape still resolves to
exactly one function (no ambiguous-overload state), and the new
`recall_dev_memory_by_files()` RPC round-trips a real write→recall→cleanup
against the live database.
CURL: N/A — verified via direct Supabase MCP `execute_sql` round trip, not
an HTTP endpoint: `select write_dev_memory(...)` with a placeholder
embedding returned a real id; `select * from recall_dev_memory_by_files(...)`
found that id by `file_paths` overlap; the test row was then deleted. See
commands.log for the exact statements run and their results.

## Phase 2-5 (same VTID-04224, same PR): read-side wiring + guardrails

AC-7: `dev-agent-memory-file-recall.ts` exposes three independent kill
switches (`isWorkerMemoryRecallEnabled`, `isValidatorMemoryRecallEnabled`,
`isPlannerMemoryRecallEnabled`), each defaulting to `false` and requiring
the exact string `'true'` (a typo stays off), and each independent of the
others.
TEST: services/gateway/test/services/dev-agent-memory-file-recall.test.ts
  → "per-stage kill switches (VTID-04224)" (3 tests)

AC-8: `renderDevMemoryFileBlock()` renders `''` for zero hits (no header
with nothing under it), clips an over-long title/content per row, and
drops whole rows — never truncates one mid-line — once a character
budget is spent.
TEST: services/gateway/test/services/dev-agent-memory-file-recall.test.ts
  → "renderDevMemoryFileBlock" (4 tests)

AC-9: `buildFileScopedMemoryBlock()` fails open to `''` on an empty file
list (no RPC call at all), an RPC `ok:false`, or a thrown exception —
never blocks or degrades the caller.
TEST: services/gateway/test/services/dev-agent-memory-file-recall.test.ts
  → "buildFileScopedMemoryBlock — fail-open contract" (4 tests)

AC-10: the Worker's single-shot prompt builder (`buildExecutionPrompt`,
`dev-autopilot-execute.ts`) splices in a passed devMemoryBlock and is
byte-identical to its pre-Phase-2 output when the block is `''`/omitted.
TEST: services/gateway/test/dev-autopilot-execute.test.ts → "buildExecutionPrompt"
  → "splices in the dev_agent_memory block when one is passed"
  → "omits the dev_agent_memory section entirely when none is passed — byte-identical to before this phase"

AC-11: the Worker's agentic prompt builders (`buildAgentTaskPrompt` —
both the plan-driven and open-ended paths — and `buildFixModeTaskPrompt`,
`autopilot-agent/agent-prompt.ts`) splice in a passed devMemoryBlock and
are byte-identical to their pre-Phase-2 output when omitted.
TEST: services/gateway/test/vtid-04224-phase2-4-prompt-memory-wiring.test.ts
  → "buildAgentTaskPrompt — dev_agent_memory splice (Worker, agentic)" (3 tests)
  → "buildFixModeTaskPrompt — dev_agent_memory splice (Worker, agentic fix mode)" (2 tests)

AC-12: the Validator's `buildReviewPrompt()` (`dev-autopilot-llm-review.ts`)
splices in a passed devMemoryBlock and is byte-identical when omitted;
`runLlmMergeReview()` calls `buildFileScopedMemoryBlock` with the PR's
changed filenames ONLY when `isValidatorMemoryRecallEnabled()` is true,
splices a successful result into the prompt sent to the router, and
fails open (review still runs and passes) when the recall call throws.
TEST: services/gateway/test/vtid-04224-phase2-4-prompt-memory-wiring.test.ts
  → "buildReviewPrompt — dev_agent_memory splice (Validator)" (2 tests)
TEST: services/gateway/test/vtid-04224-phase3-validator-memory-wiring.test.ts
  → "runLlmMergeReview — dev_agent_memory recall gating (VTID-04224 Phase 3)" (3 tests)

AC-13: the Planner's `buildPlanningPrompt()` (`dev-autopilot-planning.ts`)
splices in a passed devMemoryBlock and is byte-identical to its
pre-Phase-4 output when omitted.
TEST: services/gateway/test/vtid-04224-phase2-4-prompt-memory-wiring.test.ts
  → "buildPlanningPrompt — dev_agent_memory splice (Planner)" (2 tests)

AC-14: with all three flags at their default (unset/off), every one of
the four call sites (single-shot Worker, agentic Worker, Validator,
Planner) produces byte-identical prompts to before this phase — pinned
directly by AC-10/11/12/13's "byte-identical" assertions, and confirmed
by re-running every pre-existing suite touching these four files (24
`dev-autopilot*` suites / 559 tests, 4 `autopilot-agent-*` suites / 50+
tests) with zero regressions.
TEST: (regression sweep — see commands.log for the exact suite list and counts)

## Not covered by this PR (explicit follow-ups, not silently skipped)

- Wiring a real (non-empty) `filePaths` list into the two
  `recordExecutionOutcomeMemory` call sites in `dev-autopilot-execute.ts`
  — needs its own plan/diff lookup inside a function this repo's own
  change log flags repeatedly as high-churn and cancellation-sensitive.
- Latency/prompt-size measurement against LIVE traffic — all four flags
  ship OFF by default (not pinned on any deploy workflow in this PR), so
  there is no live signal to measure yet; the "unchanged when off" claim
  above is a structural/test guarantee, not a live measurement. Pinning a
  flag on staging and observing real recall hits/latency is a deliberate
  follow-up for an operator to run once this merges.
- A live round trip of the new recall path against a real
  `dev_agent_memory` table with real rows tagged by `stage`/`file_paths`
  (Phase 0's round trip only exercised `write_dev_memory`/
  `recall_dev_memory_by_files` directly, not through any of these four
  call sites) — this session has no way to drive a real Planner/Worker/
  Validator run end to end.

OASIS_IMPACT: no
