-- VTID-04342: user-memory embeddings move to Amazon Titan Text Embeddings V2
-- (1024-dim) — the single memory embedder. Platform-owner decision
-- 2026-09-23 (docs/MEMORY-SYSTEM-PLAN.md §7 decision 2), including
-- re-embedding existing rows.
--
-- Why the existing vectors are dropped rather than converted: they come from
-- two different models (OpenAI text-embedding-3-small 1536-dim in
-- memory_items; OpenAI-768 / Gemini text-embedding-004 in memory_facts), are
-- all older than 2026-04-28, and cannot be compared with a Titan V2 query
-- vector at all. A vector from another model space is worse than no vector.
-- AP-0910 (hourly) and the write paths re-embed every row with Titan V2.
--
-- Search RPCs (memory_semantic_search, memory_facts_semantic_search) take an
-- untyped `vector` argument and compare with `<=>`, so they need no change.
--
-- Scale at apply time: memory_items 3,183 rows (1,062 embedded),
-- memory_facts 12,684 rows (721 embedded).

-- memory_items -------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_memory_items_embedding_hnsw;

UPDATE public.memory_items
SET embedding = NULL, embedding_model = NULL, embedding_updated_at = NULL
WHERE embedding IS NOT NULL;

ALTER TABLE public.memory_items
  ALTER COLUMN embedding TYPE vector(1024);

CREATE INDEX IF NOT EXISTS idx_memory_items_embedding_hnsw
  ON public.memory_items USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

COMMENT ON COLUMN public.memory_items.embedding IS
  'VTID-04342: Amazon Titan Text Embeddings V2 (amazon.titan-embed-text-v2:0), 1024-dim. The only memory embedder (services/gateway/src/services/memory-embedding.ts).';

-- memory_facts -------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_memory_facts_embedding_hnsw;

UPDATE public.memory_facts
SET embedding = NULL, embedding_model = NULL, embedding_updated_at = NULL
WHERE embedding IS NOT NULL;

ALTER TABLE public.memory_facts
  ALTER COLUMN embedding TYPE vector(1024);

CREATE INDEX IF NOT EXISTS idx_memory_facts_embedding_hnsw
  ON public.memory_facts USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

COMMENT ON COLUMN public.memory_facts.embedding IS
  'VTID-04342: Amazon Titan Text Embeddings V2 (amazon.titan-embed-text-v2:0), 1024-dim. The only memory embedder (services/gateway/src/services/memory-embedding.ts).';
