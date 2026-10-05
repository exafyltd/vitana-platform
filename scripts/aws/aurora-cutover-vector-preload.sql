-- Aurora cutover: PRE-LOAD (run before the DMS full load; no downtime, Aurora only) (VTID-04755)
-- Generated from Supabase's live schema 2026-10-05 (the target state).
-- DMS's bulk loader cannot write pgvector columns (runbook Step 1), so the
-- 13 vector columns are staged as text for the load and cast back after.
-- `products` is excluded from the DMS load and is deliberately not touched.
-- One statement per line: run with scripts/aws/aurora-run-sql.sh.

ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS valid_source_type;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_source_type CHECK ((source_type = ANY (ARRAY['manual'::text, 'invite'::text, 'imported'::text, 'autopilot'::text, 'community_rsvp'::text, 'assistant'::text, 'journey'::text, 'vtid'::text, 'ci_cd'::text, 'nudge_engine'::text, 'health_plan'::text, 'lab_order'::text, 'appointment'::text, 'live_room'::text, 'goal_plan'::text, 'guided_journey'::text])));
DROP INDEX IF EXISTS public.ai_memory_embedding_idx;
DROP INDEX IF EXISTS public.dev_agent_memory_embedding_idx;
DROP INDEX IF EXISTS public.mem_episodes_embedding_hnsw;
DROP INDEX IF EXISTS public.mem_facts_embedding_hnsw;
DROP INDEX IF EXISTS public.idx_mem_emb_vector;
DROP INDEX IF EXISTS public.idx_memory_facts_embedding_hnsw;
DROP INDEX IF EXISTS public.idx_memory_items_embedding_hnsw;
DROP INDEX IF EXISTS public.user_intents_embedding_hnsw_idx;
DROP INDEX IF EXISTS public.idx_vtid_ledger_embedding_hnsw;
ALTER TABLE public.ai_memory ALTER COLUMN embedding TYPE text USING embedding::text;
ALTER TABLE public.calendar_events ALTER COLUMN embedding TYPE text USING embedding::text;
ALTER TABLE public.dev_agent_memory ALTER COLUMN embedding TYPE text USING embedding::text;
ALTER TABLE public.feedback_tickets ALTER COLUMN embedding TYPE text USING embedding::text;
ALTER TABLE public.mem_episodes ALTER COLUMN embedding TYPE text USING embedding::text;
ALTER TABLE public.mem_facts ALTER COLUMN embedding TYPE text USING embedding::text;
ALTER TABLE public.memory_embeddings ALTER COLUMN embedding TYPE text USING embedding::text;
ALTER TABLE public.memory_facts ALTER COLUMN embedding TYPE text USING embedding::text;
ALTER TABLE public.memory_items ALTER COLUMN embedding TYPE text USING embedding::text;
ALTER TABLE public.user_intents ALTER COLUMN embedding TYPE text USING embedding::text;
ALTER TABLE public.user_intents ALTER COLUMN embedding_v2 TYPE text USING embedding_v2::text;
ALTER TABLE public.vtid_ledger ALTER COLUMN embedding TYPE text USING embedding::text;
ALTER TABLE public.vtid_ledger ALTER COLUMN embedding_v2 TYPE text USING embedding_v2::text;
