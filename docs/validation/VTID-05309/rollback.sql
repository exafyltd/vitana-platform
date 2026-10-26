-- VTID-05309 rollback (the gateway works without the index; nothing else to revert).
DROP INDEX IF EXISTS public.idx_chat_messages_content_trgm;
-- pg_trgm stays: it was installed before this migration and other indexes use it.
