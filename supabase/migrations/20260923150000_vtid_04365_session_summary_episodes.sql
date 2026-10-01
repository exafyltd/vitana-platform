-- VTID-04365: one session-end commit, one session-summary episode per session.
--
-- Every voice/text session now ends with a single commitSessionMemory() call
-- (services/gateway/src/services/session-memory-commit.ts) that writes the
-- extracted facts plus ONE short summary of the session to memory_items.
--
-- 1. A `session_summary` category (memory_items.category_key is a FK to
--    memory_categories), mapped into the Memory Garden's `uncategorized`
--    bucket until Phase 2 gives summaries their own Garden view.
-- 2. A partial unique index on the session id carried in content_json, so the
--    summary is written at most once per session even when two gateway
--    instances (or a WS close and an SSE stop for the same session) race to
--    commit it. The losing insert gets 23505 and the caller treats it as
--    "already committed".

INSERT INTO public.memory_categories (key, label, is_active)
VALUES ('session_summary', 'Session summaries', true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.memory_category_mapping (source_category, garden_category)
SELECT 'session_summary', 'uncategorized'
WHERE NOT EXISTS (
  SELECT 1 FROM public.memory_category_mapping WHERE source_category = 'session_summary'
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_items_session_summary
  ON public.memory_items (user_id, ((content_json->>'session_id')))
  WHERE category_key = 'session_summary';

COMMENT ON INDEX public.uq_memory_items_session_summary IS
  'VTID-04365: at most one session-summary episode per (user, session).';
