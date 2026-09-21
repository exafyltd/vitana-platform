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

## Not covered by this PR (explicit follow-ups, not silently skipped)

- Wiring a real (non-empty) `filePaths` list into the two
  `recordExecutionOutcomeMemory` call sites in `dev-autopilot-execute.ts`
  — needs its own plan/diff lookup inside a function this repo's own
  change log flags repeatedly as high-churn and cancellation-sensitive.
- Read-side wiring of `recallDevMemoryByFiles()` into the Planner and
  Validator LLM routing stages (Phases 2–4 of the larger plan).

OASIS_IMPACT: no
