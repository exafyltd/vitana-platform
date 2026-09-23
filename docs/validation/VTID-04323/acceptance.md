# VTID-04323 — Vitanaland memory system: audit, plan, Phase 0

Plan: `docs/MEMORY-SYSTEM-PLAN.md`. Owner decisions answered 2026-09-23:
1. delete Cognee + Mem0, no replacement;
2. Titan V2 as the single embedder, re-embed;
3. transcripts kept 90 days;
4. isolated test DB in AWS.

Phase 0 is split across companion VTIDs, all in this PR:
- VTID-04341: fact churn
- VTID-04342: embeddings
- VTID-04343: diary
- VTID-04344: Cognee/Mem0 removal
- VTID-04345: memory health check

## Acceptance

AC-1: `write_fact()` does not insert a new row when the current fact already has the same value (trimmed, case-insensitive) and the incoming source is not stronger. A stronger source upgrades; a changed value supersedes. (VTID-04341)
TEST: local Postgres 16 run recorded in outputs/live-db-verification.md (3 cases). Applied live; `_memory_provenance_rank` present in the live body.

AC-2: user-memory embeddings come only from Amazon Titan V2 (1024-dim). No OpenAI or Google call remains on the fact-embedding path, and a per-text failure is returned as a null slot. (VTID-04342)
TEST: services/gateway/test/services/memory-facts-service-embeddings.test.ts
TEST: services/gateway/test/inline-fact-extractor-deepseek.test.ts (the Google `:embedContent` carve-out removed; any Google call now fails the test)

AC-3: `memory_items.embedding` and `memory_facts.embedding` are `vector(1024)` with HNSW indexes. The semantic-memory routes and the admin backfill embed with the memory embedder. (VTID-04342)
TEST: services/gateway/test/services/supabase-semantic-memory.test.ts
TEST: services/gateway/test/routes/semantic-memory.test.ts
Live check recorded in outputs/live-db-verification.md.

AC-4: the broker's episodic ladder runs `memory_items` semantic search first. It never queries `mem_episodes_semantic_search`, whose 1536-dim vectors come from a dead provider. It falls through to recency and then REST on an empty result or an error. (VTID-04342)
TEST: services/gateway/test/services/memory-broker-episodic-fallback.test.ts

AC-5: AP-0910 embeds the NULL backlog of both `memory_facts` and `memory_items`, skips blank content, and leaves rows NULL for the next run when Bedrock is unavailable. (VTID-04342)
TEST: services/gateway/test/services/automation-handlers-phase2.test.ts

AC-6: the DIARY block merges `diary_entries` (the app's Daily Diary) with `memory_diary_entries`, newest first, and one missing table does not blank the other. (VTID-04343)
TEST: services/gateway/test/services/memory-broker-diary-merge.test.ts

AC-7: the Cognee extractor, its gateway client, the `/relationships/from-cognee` route and the Mem0 memory-indexer client are removed. Supabase-only memory behaviour is unchanged. (VTID-04344)
TEST: services/gateway/test/services/session-memory-commit.test.ts
TEST: services/gateway/test/services/memory-source-config.test.ts
TEST: services/gateway/test/routes/admin-memory-broker.test.ts

AC-8: the morning health check gains check 21, which reads `ci_memory_health()` (service_role only, counts only). The self-audit stays last as check 22, and TOTAL_CHECKS is 22. (VTID-04345)
TEST: services/gateway/test/vtid-04345-morning-memory-check.test.ts

## OASIS

OASIS_PROOF:
- `autopilot.memory.embeddings_backfilled` (emitted by AP-0910) now carries `model`, `facts_embedded`, `facts_failed`, `items_embedded` and `items_failed`. It is emitted only when something was attempted.
- The five `cognee.extraction.*` event types are removed; nothing emitted them since 2026-04-29.
- Covered by `automation-handlers-phase2.test.ts` (AP-0910) and `tsc --noEmit` (event type union).

## Not verified here, stated plainly
- No real Titan embedding was produced from this session: `claude-code-aws-agent` gets `Operation not allowed` on `bedrock-runtime:InvokeModel`. The gateway task role already embeds `dev_agent_memory` with the same model (219 of 219 rows).
  - The first live signal is `embedding_updated_at` populating on staging after deploy, and `ci_memory_health().items_embedded_2h > 0`.
- AP-0910 has no running scheduler: AP-09xx last ran 2026-07-06. The backlog drains through embed-on-write for new rows, plus manual AP-0910 runs, until `scripts/aws/setup-eventbridge-cron-migration.sh --apply` is run by an admin.
- `vitana-memory-test` (RDS) is not created: `rds:CreateDBInstance` was denied for this session. `scripts/aws/setup-memory-test-db.sh --apply` is owner-run.
- The `vitana-cognee-extractor` ECS service (already 0 tasks) is not deleted. `scripts/aws/retire-cognee-extractor.sh --apply` is owner-run.
