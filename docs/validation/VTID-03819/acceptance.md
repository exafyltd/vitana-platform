# VTID-03819 — Backlog-aware task intake: embedding dedup + related-task chip

## Report

Part 2 of the VTID-03818..03823 plan to turn the Command Hub Tasks board and
Operator chat into a real "vibe coding" orchestrator. VTID-03818 cleaned up
the ledger's existing data-integrity bugs; this VTID stops the board from
accumulating fresh near-duplicate tasks going forward, by checking for a
similar existing task BEFORE `createOperatorTask` (the shared choke point
behind both the `autopilot_create_task` tool and the operator slash-command
intake path) writes a new ledger row.

Reuses the platform's existing embedding infrastructure (VTID-01184's
`generateEmbedding()` + the pgvector/HNSW pattern already proven on
`memory_items`) rather than building new embedding infra — per the
platform's own "prefer existing systems over rebuilding" rule. No existing
duplicate/related-task concept was found anywhere in the repo (confirmed by
grep before writing any code).

## Acceptance Criteria

AC-1 — `vtid_ledger` gains a nullable `embedding vector(1536)` column (plus
`embedding_updated_at`), an HNSW cosine-similarity index, and a
`find_similar_vtid_tasks(embedding, top_k, min_similarity)` RPC restricted to
non-terminal rows — all additive, no existing column/row touched.

TEST: `outputs/live-verification.txt` (column/index/RPC existence confirmed
live, plus a real RPC call against a synthetic vector to prove it executes
without error).

AC-2 — A request that is a near-duplicate of an existing, still-open task
(cosine similarity >= 0.93) does NOT get a new VTID allocated or a new
ledger row written; the caller instead receives the existing task's VTID
with `duplicate: true`.

TEST: `test/vtid-03819-create-operator-task-dedup.test.ts` — "short-circuits
on a duplicate" asserts zero allocator/ledger/event calls happen and the
existing VTID is returned.

AC-3 — A request that is related-but-not-duplicate (0.80-0.93 similarity)
still creates a new task normally, but the new row's `metadata` carries
`related_vtid`/`related_similarity` for the board to surface.

TEST: `test/vtid-03819-create-operator-task-dedup.test.ts` — "creates
normally on a related (non-duplicate) match" asserts the ledger PATCH body
carries the expected metadata fields.

AC-4 — Every successfully-created task gets its own embedding stamped
immediately after creation (fire-and-forget, never blocking or failing the
create call), so it becomes findable by future dedup checks.

TEST: `test/vtid-03819-create-operator-task-dedup.test.ts` — "creates
normally when no similar task is found" asserts `stampTaskEmbedding` is
called with the new VTID; `test/vtid-03819-ledger-task-dedup.test.ts`
directly unit-tests `stampTaskEmbedding`'s PATCH body shape and its
never-throws behavior under embedding/PATCH/network failure.

AC-5 — Dedup fails OPEN: if Supabase is unconfigured, embedding generation
fails (e.g. no `OPENAI_API_KEY`), or the RPC call fails/errors, task creation
proceeds exactly as it did before this VTID (no similarity data attached),
never blocked.

TEST: `test/vtid-03819-ledger-task-dedup.test.ts` — "returns {} when embedding
generation fails", "returns {} when the RPC call fails", "returns {} when the
RPC call throws", plus the source-level "Supabase-not-configured guard"
checks (this early-return reads a module-level env const captured at import
time, the same pattern `operator-service.ts` itself already uses, which
makes it unsuitable for a runtime env-toggle test — verified by source
inspection instead, consistent with this repo's own established pattern
for that class of guard, e.g. `vtid-03818-reaper-terminal-flag.test.ts`).

AC-6 — The Command Hub Tasks board renders a "Related: VTID-XXXXX" chip
(new `.task-related-chip` class, modeled on the existing
`.task-card-status-pill` visual pattern) on both the task card and the
drawer header whenever `metadata.related_vtid` is present; clicking it
filters the board to that VTID via the board's existing search field
(`state.taskSearchQuery` + `renderApp()`) — no new navigation mechanism
built.

TEST: `test/vtid-03819-related-task-chip.test.ts` (source-text regression
guard — app.js is a plain script with no module exports, same pattern as
`vtid-03818-complete-completed-drift.test.ts`).

AC-7 — `tsc --noEmit` clean; no regression in the full gateway suite.

TEST: `outputs/tsc-noemit.txt`; `outputs/jest-vtid-03819-filter.txt` (3/3
new suites, 22/22 tests); `outputs/jest-full-suite.txt` (745/746 suites — 1
pre-existing skip — 13,728/13,763 tests passing, 0 failures; the +3 suites
vs. the post-VTID-03818/VTID-03824 baseline are exactly these new files).

AC-8 — The Command Hub Path Ownership Guard (VTID-0302) accepts this PR —
`app.js`/`styles.css` changes are covered by a VTID-03819 marker registered
in `scripts/ci/command-hub-ownership-guard.js`'s allowlist, same pattern
VTID-03818 established.

TEST: manual local run recorded in `commands.log`; CI's own Path Ownership
Guard check on the PR is the live confirmation once opened.

## Deliberately NOT attempted

- **Backfilling embeddings onto the 1,682 existing `vtid_ledger` rows.**
  Embedding generation is an application-level HTTP call (OpenAI/Gemini),
  not something a SQL migration can do — batch-backfilling would need a
  separate one-off script run with real API credentials, which this session
  doesn't have visibility into being safe to run against production traffic
  volume/cost. Coverage grows organically from the moment this ships
  instead: only newly-created tasks get embeddings, and dedup only ever
  compares against what has embeddings. This is the same reasoning VTID-03818
  used for NOT backfilling the 703 placeholder-titled rows.
- **Extending the dedup check to the autonomous/self-healing task-creation
  path** (`self-healing-injector-service.ts`/`self-healing-triage-service.ts`,
  per the research). That is a genuinely separate call site on the
  autonomous execution plane (VTID-03516's plane separation), and wiring it
  in without its own dedicated review risks interacting with the "Never run
  parallel VTID executions" governance in ways this VTID didn't scope time
  to verify. Flagging it as a real, explicit follow-up rather than silently
  leaving it uncovered.
- **A UI to manually merge/dismiss a flagged duplicate/related pair.** The
  chip is read-only + a board-filter shortcut in this VTID; an actual
  merge/dismiss action is board-hygiene UI territory that belongs with
  VTID-03823 (Tasks board hygiene UI), not bundled into the detection
  mechanism here.
- **Tuning the 0.80/0.93 similarity thresholds against real production
  embeddings.** They are reasonable starting points (0.93 requires a very
  close semantic match; 0.80 is a loose "worth a human glance" floor) but
  are unvalidated against this repo's actual task-description distribution
  — expected to need adjustment once real usage data exists, not treated as
  final.
