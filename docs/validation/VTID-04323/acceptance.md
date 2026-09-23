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

## Phase 1 acceptance (VTID-04364 / 04365 / 04366 / 04367)

AC-9: every gateway fact write goes through `rememberFact()`: Identity Lock → `write_fact` → async embedding. No other source file calls the `write_fact` RPC. The inline extractor, intent hooks, diary extractor and memory-intelligence handlers all use it. (VTID-04364)
TEST: services/gateway/test/services/memory/remember.test.ts
TEST: services/gateway/test/services/memory-facts-service.test.ts
TEST: services/gateway/test/services/automation-handlers-memory-intelligence-repository.test.ts

AC-10: every session end (WS cleanup, SSE stop/close, upstream disconnect, `/end-session`, `/session/finalize`, LiveKit commit-memory) calls `commitSessionMemory()` once per session. A session with ≥ 2 user turns gets one `session_summary` episode, written by the `memory` stage and idempotent both in process and through `uq_memory_items_session_summary` (applied live). (VTID-04365)
TEST: services/gateway/test/services/session-memory-commit.test.ts
TEST: services/gateway/test/routes/orb-livekit.test.ts

AC-11: the broker's EPISODIC block reads only `memory_items`, and the SEMANTIC block reads current `memory_facts`. The gateway no longer writes or reads `mem_facts` / `mem_episodes`, and the tier-2 writer modules are deleted. (VTID-04366)
TEST: services/gateway/test/services/memory-broker.test.ts
TEST: services/gateway/test/services/memory-broker-episodic-fallback.test.ts
TEST: services/gateway/test/services/orb-memory-bridge.test.ts

AC-12: `memory_items.active_role` is NULL for personal roles and holds the role otherwise. Episodic reads pass the role (lens role first) to `memory_semantic_search` and to the REST fallback, so memory written in a work role is visible only in that role. (VTID-04367)
TEST: services/gateway/test/services/memory-broker-episodic-fallback.test.ts
TEST: services/gateway/test/services/orb-memory-bridge.test.ts
TEST: services/gateway/test/orb/live/session/upstream-message-handler.test.ts

Phase 1 verification:
- `tsc --noEmit` is clean.
- Full gateway jest: 1099 of 1100 suites pass (1 skipped); 17,799 tests pass, 0 fail (`outputs/jest-full-phase1.txt`).
- Live read-only checks: `memory_semantic_search` has `p_active_role` / `p_max_age_hours` and filters `active_role IS NULL OR = p_active_role`; all 3,183 existing `memory_items` rows have `active_role` NULL (so nothing becomes hidden); the `session_summary` category and unique index exist.

Not verified in Phase 1:
- No session summary has been written on staging yet.
- The first live signal is a `memory.session.summarized` OASIS event after this deploys to staging.
- `mem_tier2_dual_write_enabled` and the relationship-edge mirror trigger stay in place while production still runs the old reader.

## OASIS

OASIS_PROOF:
- `memory.session.summarized` (new, VTID-04365) is emitted once per written session summary, with session id, channel, trigger, memory_item_id and provider. `orb.live.memory.committed` now carries `summary_queued`.
- `autopilot.memory.embeddings_backfilled` (emitted by AP-0910) now carries `model`, `facts_embedded`, `facts_failed`, `items_embedded` and `items_failed`. It is emitted only when something was attempted.
- The five `cognee.extraction.*` event types are removed; nothing emitted them since 2026-04-29.
- Covered by `automation-handlers-phase2.test.ts` (AP-0910) and `tsc --noEmit` (event type union).

## Not verified here, stated plainly
- No real Titan embedding was produced from this session: `claude-code-aws-agent` gets `Operation not allowed` on `bedrock-runtime:InvokeModel`. The gateway task role already embeds `dev_agent_memory` with the same model (219 of 219 rows).
  - The first live signal is `embedding_updated_at` populating on staging after deploy, and `ci_memory_health().items_embedded_2h > 0`.
- AP-0910 has no running scheduler: AP-09xx last ran 2026-07-06. The backlog drains through embed-on-write for new rows, plus manual AP-0910 runs, until `scripts/aws/setup-eventbridge-cron-migration.sh --apply` is run by an admin.
- `vitana-memory-test` (RDS) is not created: `rds:CreateDBInstance` was denied for this session. `scripts/aws/setup-memory-test-db.sh --apply` is owner-run.
- The `vitana-cognee-extractor` ECS service (already 0 tasks) is not deleted. `scripts/aws/retire-cognee-extractor.sh --apply` is owner-run.
