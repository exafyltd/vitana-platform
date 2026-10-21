# VTID-04457 — embedding-service embeds with Titan only

Live evidence before the change (read-only `oasis_events`, 30 days):
`embedding.fallback_used` 219 (OpenAI failed, Titan served),
`embedding.google_fallback_used` 2 (last 2026-09-22 22:07 UTC),
`embedding.all_providers_failed` 2.

| AC | Statement | Evidence |
|---|---|---|
| AC-1 | `generateEmbedding` calls Titan only; no OpenAI or Google request is made even with their keys set. | TEST: `test/embedding-service.test.ts` "embeds with Titan and never calls OpenAI or Gemini" |
| AC-2 | A Titan failure returns ok:false with one error event naming the provider; there is no fallback. | TEST: `test/embedding-service.test.ts` "a Titan failure is ok:false…" |
| AC-3 | Batch embeds each text with Titan in order, fails as a whole, never returns a partial list. | TEST: `test/embedding-service.test.ts` generateBatchEmbeddings block |
| AC-4 | Dimensions stay 1536 (the columns' size); no schema change. | TEST: `test/embedding-service.test.ts` (`EMBEDDING_DIMENSIONS` = 1536) |
| AC-5 | The source contains no OpenAI or Google endpoint or key. | TEST: `test/embedding-service.test.ts` "source guard" |
| AC-6 | Callers (intents, ledger dedup, nav catalog, semantic-memory) still pass. | TEST: 13 suites / 402 tests (commands.log) |

Not in this VTID: moving these columns to Titan V2 1024 (expand/contract,
shared database), recorded in the plan as the next step.
