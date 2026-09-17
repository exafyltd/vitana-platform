# VTID-04025 — W4c: memory that accrues — dev_agent_memory rows from every operator turn and every executor run (gap analysis §4.3)

Context: `docs/OPERATOR-CONSOLE-GAP-ANALYSIS-2026-09-17.md` §4.3 — `writeDevMemory` on decisions/gotchas/failures/preferences "extracted by the `memory` policy stage from each completed turn (not only five tool names)", and the executor writing `task_outcome` + `gotcha` rows from each run. Until now the only live writer was `recordSessionOutcomeMemory` (VTID-03928), keyed on five tool names; an owner decision stated in chat, a gotcha the console hit, a preference — all evaporated with the browser tab, and a failed Dev Autopilot run left no memory of why.

What ships: `services/gateway/src/services/operator-turn-memory.ts`. (1) `extractAndRecordTurnMemory` — after each completed `/api/v1/operator/chat` turn (`routes/operator.ts`, fire-and-forget, after the reply is computed), the `memory` routing stage (its own provider order: Bedrock primary / DeepSeek fallback, never Google) is asked for the durable facts of the turn as a JSON array (≤3, categories `decision|convention|incident|preference|gotcha` — `task_outcome` stays VTID-03928's and the executor's), parsed tolerantly, clamped, deduped, VTID picked up from the item/text/route hint, and written with `source:'session'`, tags `operator-console`/`turn-extracted`/`<category>` and thread provenance in the content; trivial turns are skipped before any model call. (2) `recordExecutionOutcomeMemory` — `applyExecutionResult` (`dev-autopilot-execute.ts`) writes a `task_outcome` row when a run opens a PR and a `gotcha` row when a run fails, carrying the failure reason (which already includes the W0 CI log excerpt). Both gated on `OPERATOR_TURN_MEMORY_ENABLED=true` (default off, not pinned anywhere); fail-open everywhere.

AC-1 — The gate is the exact string `true`; `shouldExtract` skips empty/trivial turns (short reply without tools) and keeps tool turns and substantive replies, so no model call is made for chatter.
TEST: services/gateway/test/vtid-04025-operator-turn-memory.test.ts

AC-2 — The extraction prompt names the allowed categories (never `task_outcome`), the per-turn cap, the exclusions (transient status, restatements, speculation), the thread summary when present and the turn's tool calls; `parseExtraction` accepts a fenced array, drops unknown categories, `task_outcome`, and too-short items, clamps importance/title/content, dedupes by title, caps at 3, picks up a VTID from the item, the text, or the route hint, and returns `[]` for empty/non-JSON/non-array output.
TEST: services/gateway/test/vtid-04025-operator-turn-memory.test.ts

AC-3 — `extractAndRecordTurnMemory` is a no-op when disabled or trivial (no extractor call), writes each extracted item with the session source/tags/category/VTID and thread provenance, and fails open (extractor throws → 0 written; empty extractor → skipped; a failed write is logged and not counted); the default extractor calls the `memory` routing stage.
TEST: services/gateway/test/vtid-04025-operator-turn-memory.test.ts

AC-4 — `buildExecutionOutcomeMemory` renders a `task_outcome` row (importance 40, `pr_opened` tag, PR/branch/VTID in the text) for an opened PR and a `gotcha` row (importance 55, `failed` tag, reason in title and content) for a failure; `recordExecutionOutcomeMemory` honours the gate, writes once, and never throws.
TEST: services/gateway/test/vtid-04025-operator-turn-memory.test.ts

AC-5 — Wiring: the chat route calls the extractor after `processWithGemini`, fire-and-forget, with the thread summary (VTID-04022) and the VTID hint; `applyExecutionResult` records the outcome on both its branches, fire-and-forget; the operator-chat, thread and executor suites still pass.
TEST: services/gateway/test/vtid-04025-operator-turn-memory.test.ts
TEST: services/gateway/test/vtid-04022-operator-threads.test.ts
TEST: services/gateway/test/dev-autopilot-execute.test.ts
TEST: services/gateway/test/operator-chat-oasis.test.ts

OASIS_PROOF: no OASIS topic, payload or consumer change — the executor's `dev_autopilot.execution.pr_opened`/`failed` events are emitted exactly as before and the memory write happens after them, fire-and-forget; the operator-chat OASIS suite above passes unmodified.

Not verified here: a live turn with the flag on (not pinned anywhere yet; the owner's staging pin is the exercise — the signal is `[operator-turn-memory] thread …: N memory row(s) written` in the staging gateway log and new `turn-extracted` rows in `dev_agent_memory`). Cost note: one small `memory`-stage call per non-trivial turn; the cap and the skip heuristic bound it.
