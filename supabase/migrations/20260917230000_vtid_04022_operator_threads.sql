-- VTID-04022 (operator agent W4b): server-side Operator Console threads.
--
-- docs/OPERATOR-CONSOLE-GAP-ANALYSIS-2026-09-17.md §4.3: the console's
-- transcript lives in the browser (localStorage, VTID-03822) and its only
-- cross-session memory is dev_agent_memory rows written by a handful of
-- tool outcomes (VTID-03928). These two tables give every operator turn a
-- server-side record and every thread a rolling summary the gateway can
-- recall memory against (summary + current message, not the raw message
-- alone). The oasis_events audit row per message stays as it is.
--
-- Ships as a FILE. Apply on the platform owner's go (RUN-MIGRATION.yml or
-- the Supabase MCP); the gateway code behind OPERATOR_THREADS_ENABLED is
-- fail-open when these tables are absent, so deploying the code first is
-- safe — it just records nothing until the tables exist.

CREATE TABLE IF NOT EXISTS public.operator_threads (
  -- The client-supplied threadId the Command Hub already uses (uuid text).
  id TEXT PRIMARY KEY,
  user_id UUID,
  tenant_id UUID,
  role TEXT,
  title TEXT,
  -- Rolling summary of the conversation so far, rewritten every
  -- OPERATOR_THREAD_SUMMARY_EVERY turns by the `memory` routing stage.
  summary TEXT,
  summary_turns INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.operator_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id TEXT NOT NULL REFERENCES public.operator_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  tool_name TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operator_messages_thread_created
  ON public.operator_messages (thread_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_threads_user_updated
  ON public.operator_threads (user_id, updated_at DESC);

ALTER TABLE public.operator_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_messages ENABLE ROW LEVEL SECURITY;

-- The gateway writes and reads with the service role; the browser never
-- talks to these tables directly (it talks to /api/v1/operator/*).
DROP POLICY IF EXISTS operator_threads_service_role ON public.operator_threads;
CREATE POLICY operator_threads_service_role
  ON public.operator_threads FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS operator_messages_service_role ON public.operator_messages;
CREATE POLICY operator_messages_service_role
  ON public.operator_messages FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.operator_threads TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.operator_messages TO service_role;

COMMENT ON TABLE public.operator_threads IS
  'VTID-04022: Operator Console threads (server-side). One row per Command Hub thread id; carries a rolling summary the gateway recalls dev_agent_memory against.';
COMMENT ON TABLE public.operator_messages IS
  'VTID-04022: Operator Console messages (server-side). user/assistant/tool turns per thread; the oasis_events audit row per message is unchanged.';
