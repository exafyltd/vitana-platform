# VTID-04027 — Operator memory recall: top-10, category-diverse, bounded (gap analysis §4.3, recall side)

Context: `docs/OPERATOR-CONSOLE-GAP-ANALYSIS-2026-09-17.md` §4.3 ends with "recall query = summary + current message, top-10, category-diverse". W4b (VTID-04022) delivered the query; recall itself was still the top-5 rows by raw cosine similarity. With W4c (VTID-04025) writing rows from every turn, a thread about one incident fills every slot with near-duplicate `incident` rows and crowds out the one `decision` or `convention` that matters — and the rendered block had no size bound at all.

What ships: `services/gateway/src/services/dev-memory-ranking.ts` — `diversifyRecallHits` (round-robin over categories in similarity order: every category with a relevant row gets a seat before any category gets a second, `RECALL_MAX_PER_CATEGORY` = 4, `RECALL_SELECT` = 10, dedupe by id, output re-sorted by similarity) and `renderDevMemoryBlock` (the VTID-03892 header kept verbatim, per-row title/content clip, `RECALL_BLOCK_MAX_CHARS` = 6 000 total, rows dropped best-first). `processWithGemini` now fetches `RECALL_CANDIDATES` = 20 rows and `buildDevMemoryContextBlock` delegates to the two pure functions. No schema, RPC or flag change.

AC-1 — `diversifyRecallHits` gives every category a seat before any category gets a second, keeps similarity order in the output, fills remaining seats round-robin up to the per-category cap and the limit, defaults to `RECALL_SELECT` rows, dedupes by id, and handles empty input.
TEST: services/gateway/test/vtid-04027-dev-memory-recall-ranking.test.ts

AC-2 — `renderDevMemoryBlock` keeps the VTID-03892 header (the string the existing consumers assert on), tags the VTID, clips each row's title and content, and drops rows beyond the total budget best-first.
TEST: services/gateway/test/vtid-04027-dev-memory-recall-ranking.test.ts

AC-3 — Wiring: `processWithGemini` fetches `RECALL_CANDIDATES` rows and the prompt block carries at most `RECALL_SELECT` of them with at most `RECALL_MAX_PER_CATEGORY` per category while every other category with a hit is present; the VTID-03892 wiring suite (limit expectation updated to 20) and the VTID-03930 overview suite still pass.
TEST: services/gateway/test/vtid-04027-dev-memory-recall-ranking.test.ts
TEST: services/gateway/test/vtid-03892-operator-dev-memory-wiring.test.ts
TEST: services/gateway/test/vtid-03930-operator-codebase-overview.test.ts

OASIS_PROOF: no OASIS topic, payload or consumer change — this VTID changes only which recalled rows are rendered into the operator system prompt and how the block is bounded.

Not verified here: the served prompt on staging after deploy (the block is not echoed in the chat response); the signal is a turn that recalls a `decision` alongside several `incident` rows where the old top-5 would have shown incidents only. Cost note: the RPC now returns 20 candidates instead of 5 — one PostgREST call either way.
