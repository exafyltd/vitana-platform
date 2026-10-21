-- VTID-01992: Covering index for the async intent embedding worker.
--
-- The worker polls user_intents WHERE embedding IS NULL ORDER BY created_at
-- LIMIT 16 every 5s. Without a partial index this is a sequential scan of
-- the table on every tick. The partial index keeps only un-embedded rows,
-- so it stays small (typically a few dozen rows in steady state) regardless
-- of total table size.

CREATE INDEX IF NOT EXISTS user_intents_embedding_pending_idx
  ON public.user_intents (created_at ASC)
  WHERE embedding IS NULL;

COMMENT ON INDEX public.user_intents_embedding_pending_idx IS
  'Backs the intent-embedding-worker poll: WHERE embedding IS NULL ORDER BY created_at LIMIT 16. Partial — only the un-embedded rows.';
