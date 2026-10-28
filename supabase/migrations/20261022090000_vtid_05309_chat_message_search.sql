-- VTID-05309 (messenger-ux-v2/api-message-search): index for GET /api/v1/chat/search (plan I5).
--
-- The search runs ILIKE '%q%' on chat_messages.content (q ≥ 3 characters), scoped to the caller's tenant, DMs and
-- groups. A pg_trgm GIN index serves those patterns; without it the search still works as a scan.
--
-- Measured read-only on 2026-10-22: chat_messages 53,278 rows, 62 MB total / 27 MB heap, ~9.9 MB of content
-- (avg 241 chars); pg_trgm 1.6 is already installed in schema public; no GIN index on chat_messages yet.
-- Build mode: inside the transaction (not CONCURRENTLY), the same choice as 20261021140000_vtid_05310. CREATE INDEX
-- holds a SHARE lock — inserts into chat_messages wait while the table is scanned once; at ~10 MB of text that is
-- expected to take a few seconds at most. Run outside peak hours. File names in attachments are matched without an
-- index (24 attachment rows today).
--
-- Additive and idempotent. Rollback: docs/validation/VTID-05309/rollback.sql.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE INDEX IF NOT EXISTS idx_chat_messages_content_trgm
  ON public.chat_messages USING gin (content public.gin_trgm_ops);

COMMENT ON INDEX public.idx_chat_messages_content_trgm IS
  'VTID-05309: trigram index for message search (GET /api/v1/chat/search, ILIKE on content).';

COMMIT;
