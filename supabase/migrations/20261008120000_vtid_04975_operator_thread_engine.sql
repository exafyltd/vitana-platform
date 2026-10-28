-- VTID-04975: per-thread engine for Operator Console threads.
--
-- The Command Hub Operator can drive Kiro (kiro-cli over ACP) instead of the
-- LLM router. The engine is chosen when a thread is created and never changes
-- afterwards, so a Kiro thread's history stays in its Kiro session.
-- Existing rows are LLM threads. Plan: docs/validation/VTID-04975/plan-sparring.md
--
-- Additive and safe in any order with the gateway code: the gateway reads and
-- writes `engine` fail-open and treats a missing column as 'llm'.

ALTER TABLE public.operator_threads
  ADD COLUMN IF NOT EXISTS engine TEXT NOT NULL DEFAULT 'llm';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'operator_threads_engine_check'
  ) THEN
    ALTER TABLE public.operator_threads
      ADD CONSTRAINT operator_threads_engine_check CHECK (engine IN ('llm', 'kiro'));
  END IF;
END $$;

COMMENT ON COLUMN public.operator_threads.engine IS
  'VTID-04975: which engine answers this thread: llm (router, default) or kiro (kiro-cli ACP). Set at creation, never updated.';
