# Live database verification (read-only queries, 2026-09-23, project inmkhvwdcuyhnxkgfvsb)

## Before (audit)
- memory_facts: 12,684 rows, 918 current; 10,097 are `preferred_language` (system_observed) rewrites
- embeddings: memory_items last embedded 2026-04-26 (1,062 of 3,183, OpenAI 1536);
  memory_facts 721 of 12,684 (688 OpenAI + 33 Gemini, 768); mem_facts 0 of 13,912
- system_controls: memory_broker_enabled, mem_tier2_dual_write_enabled, vitana_brain_enabled,
  vitana_brain_orb_enabled, tier0_redis_enabled = true; cognee_extraction_enabled = false (since 2026-04-29)
- automation_runs: AP-0906..AP-0913 last run 2026-07-06..07-12 (scheduler dead)
- memory.orchestrator.context_built (14d): 592 events; sampled turns diary_loaded = 0

## After applying the Phase 0 migrations
- write_fact body contains `_memory_provenance_rank`: true; service_role EXECUTE: true
- memory_items.embedding = vector(1024); memory_facts.embedding = vector(1024); both HNSW indexes present (2)
- ci_memory_health() at 2026-09-23T11:38Z:
  {"facts_written_24h":24,"items_written_24h":5,"preferred_language_writes_24h":21,
   "facts_active_2h":918,"facts_active_embedded_2h":0,"items_2h":3183,"items_embedded_2h":0,
   "last_embedding_at":null,"dlq_new_24h":0,"context_built_24h":37,"context_with_memory_24h":37,
   "context_with_diary_24h":0,"ap0910_last_run":"2026-07-06T23:12:07.924+00:00"}
  (0% embedded is the expected state right after the column change; it is the backlog
  AP-0910 and the write paths now drain.)

## write_fact behaviour (local Postgres 16, not production)
- same value written 3x (system_observed) -> 1 row
- changed value -> 2 rows, 1 current ("English")
- inferred, inferred, user_stated, inferred (same value) -> 2 rows, current = user_stated
