-- D11.A1 — Fix the embedding dimension mismatch (VTID-DANCE-D11)
--
-- The user_intents table was created with vector(768) (P2-A migration
-- 20260501000100_user_intents.sql) to "match Gemini text-embedding model".
-- But the embedding-service.ts in the gateway returns 1536-dim vectors
-- (it requests outputDimensionality:1536 from Gemini). The mismatch caused
-- every UPDATE of the embedding column to fail silently in the route,
-- leaving every intent with embedding=NULL — which the matcher's
-- WHERE ui.embedding IS NOT NULL filter then excluded entirely. Result:
-- two users dictating "looking for somebody to dance" never matched.
--
-- Fix: drop the column + HNSW index, re-add as vector(1536) (matching the
-- service output), recreate HNSW. All current intents have embedding=NULL
-- so no data is destroyed. Backfill happens lazily via the next post or
-- via the daily pre-compute batch (D12 cron).

-- Drop dependent index first.
DROP INDEX IF EXISTS public.user_intents_embedding_hnsw_idx;
DROP INDEX IF EXISTS public.user_intents_embedding_idx;

-- Drop + re-add the column. ALTER TYPE on a vector column with a different
-- dimension isn't supported by pgvector; drop+add is the canonical path.
ALTER TABLE public.user_intents
  DROP COLUMN IF EXISTS embedding;

ALTER TABLE public.user_intents
  ADD COLUMN embedding vector(1536);

-- HNSW index for cosine similarity (matches embedding-service's
-- preferred metric).
CREATE INDEX IF NOT EXISTS user_intents_embedding_hnsw_idx
  ON public.user_intents
  USING hnsw (embedding vector_cosine_ops);

COMMENT ON COLUMN public.user_intents.embedding IS
  '1536-dim semantic embedding (matches embedding-service.ts output). Backfilled lazily on post and via D12 daily pre-compute batch. Cosine similarity via HNSW.';
