# VTID-04460 — intent and ledger embeddings move to Titan V2 (expand)

Decision 2 of `docs/MEMORY-SYSTEM-PLAN.md`: Titan V2 1024 everywhere.
Staging and prod share one database, so this is expand/contract.

| AC | Statement | Evidence |
|---|---|---|
| AC-1 | `embedding-service` embeds with Titan V2 (1024 dims) and nothing else. | TEST: `test/embedding-service.test.ts` |
| AC-2 | Every `user_intents` embedding writer writes `embedding_v2`; the worker polls `embedding_v2 IS NULL`. | TEST: `test/vtid-04460-embedding-v2-wiring.test.ts` "writers" |
| AC-3 | Readers call `compute_intent_matches_v2`, `search_intent_catalog_v2`, `find_similar_vtid_tasks_v2`; ledger dedup stamps `embedding_v2`. | TEST: `test/vtid-04460-embedding-v2-wiring.test.ts` "readers"; `test/vtid-03819-ledger-task-dedup.test.ts` |
| AC-4 | The migration is additive (no DROP, no ALTER COLUMN), the `_v2` bodies read only `embedding_v2`, and the catalog cast is `vector(1024)`. | TEST: `test/vtid-04460-embedding-v2-wiring.test.ts` "migration" |
| AC-5 | The `_v2` functions are not callable by anon; ledger dedup is service_role only. | TEST: `test/vtid-04460-embedding-v2-wiring.test.ts`; live ACL read in commands.log |
| AC-6 | Callers of the embedder still pass. | TEST: 15 suites / 414 tests (commands.log) |

Applied live 2026-09-24 (`vtid_04460_intent_ledger_embeddings_titan_v2`,
`vtid_04460_find_similar_v2_service_role_only`). Prod's current gateway keeps
writing `embedding` and calling the old functions, which are untouched.

Not verified live: staging is unreachable. After deploy, `user_intents.embedding_v2`
should fill for open intents within minutes (the worker runs every 5 s).
