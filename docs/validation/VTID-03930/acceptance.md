# VTID-03930 — Operator Console: always-on codebase orientation block

## Report / context

The platform owner's standing instruction: "every single new operator
session must have the full list of tools and the full list of access and
permissions... RepoWise, Graphify... wired." Investigated whether RepoWise
and Graphify (both real, working CLI tools — confirmed via `repowise
status`, `graphify god-nodes --top 15`) can be invoked live by the
Operator Console.

**They cannot, as a hard architectural fact, not a judgment call.** Both
are local CLI tools operating on session-scoped index files
(`graphify-out/graph.json`, `.repowise/`) that exist only inside a Claude
Code session's own sandbox filesystem. The deployed ECS gateway container
that actually serves `POST /api/v1/operator/chat` has neither the
binaries nor the index files — there is no live query path from that
process to either tool. Standing up a hosted RepoWise/Graphify service
the gateway could call would be new infrastructure requiring its own VTID
and deployment, not a wiring fix.

## Fix — the practical equivalent

Built what the underlying ask actually wants ("understand the codebase
immediately, based on the index catalog, without burning tokens
re-deriving it") using content sourced from a real run of both tools:

```
$ graphify god-nodes --top 15
$ repowise health
$ repowise status
```

New `CODEBASE_OVERVIEW_BLOCK` constant in `gemini-operator.ts` — a small
(~800 char), hand-curated summary: the services table (from CLAUDE.md
§2), the real architectural hubs graphify reported (RunContext,
function_tool(), summarize(), emitOasisEvent(), getSupabase(),
_dispatch(), etc.), and the known health hotspot (`orb-live.ts`, lowest
maintainability score). Appended **unconditionally** to every Operator
turn's system prompt — the exact same unconditional pattern
`buildDevMemoryContextBlock` (VTID-03892) already uses — so a brand-new
session gets codebase orientation on its very first message, without
waiting on a tool call or depending on `userRole`.

For anything beyond this summary, the block explicitly points to the
tools that already exist and are now reachable (VTID-03926):
`dev_search_codebase`, `dev_read_file`, `dev_db_query`.

## Refresh mechanism

Static content, not a live query — refreshed by re-running the three
commands above and editing the constant, noted in its own doc comment
with a "last generated" date. This is a deliberate tradeoff: zero new
infrastructure, at the cost of needing a manual refresh (and a redeploy)
to stay current, versus the deeper `docs/`-indexed content path
(`knowledge_search`, already tsvector-searchable) for anything that
should update without a code change.

## Acceptance Criteria

AC-1 — the codebase orientation block is present in every Operator
system prompt, whether the default operator prompt or a caller-supplied
custom instruction (e.g. ORB memory context) is used as the base.

TEST: `outputs/jest-new-suite.txt` — "appends the codebase orientation
block to the default operator system prompt", "...after a caller-supplied
custom system instruction too".

AC-2 — it is present unconditionally, independent of `userRole` — this is
background orientation, not a gated tool result.

TEST: `outputs/jest-new-suite.txt` — "is present unconditionally,
independent of userRole".

AC-3 — when both the dev_agent_memory block and the codebase overview
block are present, they appear in a stable, sensible order (memory, then
orientation).

TEST: `outputs/jest-new-suite.txt` — "appends after the dev_agent_memory
block when both are present".

## Verification

- `tsc --noEmit`: clean (`outputs/tsc-noemit.txt`).
- New suite: `outputs/jest-new-suite.txt` — 4/4 passing.
- Full gateway suite (regression check): `outputs/jest-full-suite.txt` —
  906/907 suites (1 pre-existing skip), 14,982/15,017 tests passing, 0
  failures.
- Existing prompt-content test
  (`vtid-03838-operator-prompt-lists-execute-tool.test.ts`) uses only
  `toContain` assertions, not exact-match/snapshot — confirmed unaffected
  by this additive change.

## What this does NOT do

- Does not give the Operator a live RepoWise/Graphify query capability —
  that would need a hosted service neither tool has today, a separate,
  larger VTID.
- Does not auto-refresh. The block is a point-in-time summary; a future
  session should re-run the three commands above and update the constant
  as the codebase changes materially.
- Does not replace `dev_search_codebase`/`dev_read_file`/`dev_db_query`
  for anything specific — it is explicitly scoped as orientation only,
  and says so in its own text.

## OASIS impact

OASIS_IMPACT: no — system-prompt content addition only, no schema/event changes.
