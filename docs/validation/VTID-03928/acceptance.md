# VTID-03928 — Operator Console: auto-write real session outcomes into dev_agent_memory

## Report / context

Direct follow-up to VTID-03926 and a live test round against staging that
found the platform owner's "cross-session memory" ask already has a real,
working retrieval brain — `recallDevMemory()` (VTID-03892), a pgvector
cosine-similarity search over `dev_agent_memory`, already runs on every
Operator turn (including a brand-new thread's very first message) and
already returns only the top-K (5-8) most relevant rows, never the whole
history. Verified directly against staging: the `recall_dev_memory` RPC
self-match scored 1.0, related rows ranked sensibly (0.57, 0.43, ...).

The actual gap, confirmed by grepping every call site of `writeDevMemory`
in `services/gateway/src`: **it is never called anywhere in the live
Operator path.** All 26 pre-existing `dev_agent_memory` rows carry
`source: 'backfill'` — a one-time import of the CLAUDE.md changelog.
Nothing has fed it since. So the relevance-selection mechanism the
platform owner asked for (their own words: "it should not be stuck
reading hundreds of sessions... only understand the relevance... pick out
the correct space") already exists and works — it just has nothing new to
find.

## Root cause

`recallDevMemory`/`writeDevMemory` (`services/gateway/src/services/dev-agent-memory.ts`)
are a matched read/write pair. Only the read half was ever wired into
`routes/operator.ts` → `services/gemini-operator.ts`. No route, no tool
executor, and no completion hook ever calls `writeDevMemory` for real
Operator activity.

## Fix

`routes/operator.ts`'s `/chat` handler now calls a new
`recordSessionOutcomeMemory()` helper, fire-and-forget, right before the
response is sent:

1. If a task was created this turn (explicit `/task` command or the
   model's own `autopilot_create_task` tool call) and it isn't a
   duplicate, write a `task_outcome` memory row.
2. For each tool result in `geminiResult.toolResults` whose name is in
   `SIGNIFICANT_OUTCOME_TOOLS` (`dev_merge_pr`, `dev_deploy_service`,
   `dev_approve_spec`, `dev_approve_item`, `autopilot_create_task`) AND
   whose `response.ok === true`, write a `task_outcome` memory row
   summarizing what happened.

Deliberately narrow: a codebase search, a status read, or a failed
attempt is not a decision worth remembering — only a real, successful
outcome is. The write is `.catch()`-wrapped and never awaited inline, so
a Supabase/embedding failure can never delay or fail the user-facing chat
response — the same fail-open convention `recallDevMemory` itself already
uses.

## Acceptance Criteria

AC-1 — a successful significant tool call (e.g. `dev_merge_pr` with
`response.ok: true`) triggers exactly one `writeDevMemory` call with
`repo: 'vitana-platform'`, `category: 'task_outcome'`, `source: 'session'`,
and the outcome's own `vtid` when present.

TEST: `outputs/jest-new-suite.txt` — "writes a memory row when a
significant tool call succeeds (dev_merge_pr)".

AC-2 — a failed tool call (`response.ok: false`) never writes a memory row.

TEST: `outputs/jest-new-suite.txt` — "does NOT write a memory row for a
failed tool call".

AC-3 — a non-significant tool call (e.g. `dev_search_codebase`) never
writes a memory row, even on success.

TEST: `outputs/jest-new-suite.txt` — "does NOT write a memory row for a
non-significant tool call".

AC-4 — a `writeDevMemory` rejection never blocks or fails the chat
response (fail-open, matching `recallDevMemory`'s own convention).

TEST: `outputs/jest-new-suite.txt` — "never blocks or fails the chat
response when writeDevMemory rejects".

## Verification

- `tsc --noEmit`: clean (`outputs/tsc-noemit.txt`).
- New suite: `outputs/jest-new-suite.txt` — 5/5 passing.
- Full gateway suite (regression check): `outputs/jest-full-suite.txt` —
  905/906 suites (1 pre-existing skip), 14,978/15,013 tests passing, 0
  failures.

## What this does NOT do

- Does not touch `OPERATOR_AWS_READONLY_ENABLED` — that flag is a
  deliberate, documented security gate (see `aws-ecs-readonly.ts`'s own
  header comment: the tool currently runs under the same broad IAM role
  that can also launch ECS tasks, since the narrower STS role was never
  built). Enabling it needs its own VTID for the IAM work, not a flag flip.
- Does not wire RepoWise or Graphify into the Operator. Both are local
  CLI tools with session-scoped indexes (`graphify-out/graph.json`,
  `.repowise/`) — they are not services the deployed ECS gateway container
  can reach at request time. A real equivalent (a periodically-refreshed
  codebase-overview surfaced the same way `knowledge_search` already
  surfaces indexed `docs/` content) is a separate, larger VTID.
- Does not add a distinct "session start" event. `recallDevMemory` already
  runs on every turn, so a brand-new thread's first message already gets
  the benefit of whatever this VTID writes in future turns — no additional
  wiring was needed on the read side.

## OASIS impact

OASIS_IMPACT: no — writes to `dev_agent_memory` only, no schema/event changes.
