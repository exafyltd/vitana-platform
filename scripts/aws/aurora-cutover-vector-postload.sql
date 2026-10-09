-- Aurora cutover: POST-LOAD (run after the DMS full load finishes with 0 errors) (VTID-04755)
-- Generated from Supabase's live schema 2026-10-05 (the target state).
-- DMS's bulk loader cannot write pgvector columns (runbook Step 1), so the
-- 13 vector columns are staged as text for the load and cast back after.
-- `products` is excluded from the DMS load and is deliberately not touched.
-- One statement per line: run with scripts/aws/aurora-run-sql.sh.

-- 2026-10-09: DMS truncates vector values on the source read (571 of 768
-- values arrived), so only complete '[...]' texts are cast; truncated ones
-- become NULL and must be backfilled from Supabase separately.
ALTER TABLE public.ai_memory ALTER COLUMN embedding TYPE vector(768) USING CASE WHEN embedding LIKE '[%]' THEN embedding::vector END;
ALTER TABLE public.calendar_events ALTER COLUMN embedding TYPE vector(1536) USING CASE WHEN embedding LIKE '[%]' THEN embedding::vector END;
ALTER TABLE public.dev_agent_memory ALTER COLUMN embedding TYPE vector(1024) USING CASE WHEN embedding LIKE '[%]' THEN embedding::vector END;
ALTER TABLE public.feedback_tickets ALTER COLUMN embedding TYPE vector(1536) USING CASE WHEN embedding LIKE '[%]' THEN embedding::vector END;
ALTER TABLE public.mem_episodes ALTER COLUMN embedding TYPE vector(1536) USING CASE WHEN embedding LIKE '[%]' THEN embedding::vector END;
ALTER TABLE public.mem_facts ALTER COLUMN embedding TYPE vector(1536) USING CASE WHEN embedding LIKE '[%]' THEN embedding::vector END;
ALTER TABLE public.memory_embeddings ALTER COLUMN embedding TYPE vector(768) USING CASE WHEN embedding LIKE '[%]' THEN embedding::vector END;
ALTER TABLE public.memory_facts ALTER COLUMN embedding TYPE vector(1024) USING CASE WHEN embedding LIKE '[%]' THEN embedding::vector END;
ALTER TABLE public.memory_items ALTER COLUMN embedding TYPE vector(1024) USING CASE WHEN embedding LIKE '[%]' THEN embedding::vector END;
ALTER TABLE public.user_intents ALTER COLUMN embedding TYPE vector(1536) USING CASE WHEN embedding LIKE '[%]' THEN embedding::vector END;
ALTER TABLE public.user_intents ALTER COLUMN embedding_v2 TYPE vector(1024) USING CASE WHEN embedding_v2 LIKE '[%]' THEN embedding_v2::vector END;
ALTER TABLE public.vtid_ledger ALTER COLUMN embedding TYPE vector(1536) USING CASE WHEN embedding LIKE '[%]' THEN embedding::vector END;
ALTER TABLE public.vtid_ledger ALTER COLUMN embedding_v2 TYPE vector(1024) USING CASE WHEN embedding_v2 LIKE '[%]' THEN embedding_v2::vector END;
CREATE INDEX ai_memory_embedding_idx ON public.ai_memory USING ivfflat (embedding vector_cosine_ops) WITH (lists='100');
CREATE INDEX dev_agent_memory_embedding_idx ON public.dev_agent_memory USING ivfflat (embedding vector_cosine_ops) WITH (lists='100');
CREATE INDEX mem_episodes_embedding_hnsw ON public.mem_episodes USING hnsw (embedding vector_cosine_ops) WITH (m='16', ef_construction='64');
CREATE INDEX mem_facts_embedding_hnsw ON public.mem_facts USING hnsw (embedding vector_cosine_ops) WITH (m='16', ef_construction='64');
CREATE INDEX idx_mem_emb_vector ON public.memory_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists='100');
CREATE INDEX idx_memory_facts_embedding_hnsw ON public.memory_facts USING hnsw (embedding vector_cosine_ops) WITH (m='16', ef_construction='64');
CREATE INDEX idx_memory_items_embedding_hnsw ON public.memory_items USING hnsw (embedding vector_cosine_ops) WITH (m='16', ef_construction='64');
CREATE INDEX user_intents_embedding_hnsw_idx ON public.user_intents USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_vtid_ledger_embedding_hnsw ON public.vtid_ledger USING hnsw (embedding vector_cosine_ops) WITH (m='16', ef_construction='64');
