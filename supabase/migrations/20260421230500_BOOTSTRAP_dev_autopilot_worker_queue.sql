-- =============================================================================
-- BOOTSTRAP-DEV-AUTOPILOT-WORKER-QUEUE
-- Date: 2026-04-21
--
-- Queue that lets a local Claude-Code-authenticated worker (running on the
-- developer workstation or a small always-on VM) handle the LLM calls for
-- Dev Autopilot plan-generation and plan-execution, so those calls draw
-- from the Claude subscription instead of the pay-per-token API key that
-- the gateway currently uses.
--
-- Flow:
--   1. Gateway enqueues a row (status='pending', kind='plan' | 'execute',
--      input_payload={ prompt, model, max_tokens, ... }).
--   2. Worker polls, atomically claims via PATCH ?status=eq.pending&id=eq.N
--      → status='running', sets worker_id + started_at.
--   3. Worker shells out to `claude -p <prompt>` (uses the user's Claude
--      subscription auth), captures output.
--   4. Worker PATCHes the row → status='completed' (output_payload) or
--      status='failed' (error_message).
--   5. Gateway, which was polling, reads the completed row and proceeds
--      with the state machine (write files, open PR, etc).
--
-- Stuck-row recovery: a gateway watchdog reclaims rows stuck in 'running'
-- longer than `stuck_timeout_minutes` (default 15) by marking them 'failed'
-- with a 'stuck-in-running' error, so the bridge / self-heal flow picks
-- them up.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.dev_autopilot_worker_queue;
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.dev_autopilot_worker_queue (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text        NOT NULL CHECK (kind IN ('plan', 'execute')),
  finding_id       uuid        NOT NULL,
  execution_id     uuid,
  status           text        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  input_payload    jsonb       NOT NULL,
  output_payload   jsonb,
  error_message    text,
  attempts         int         NOT NULL DEFAULT 0,
  worker_id        text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Poller hot-path: grab the oldest pending row.
CREATE INDEX IF NOT EXISTS idx_worker_queue_pending
  ON public.dev_autopilot_worker_queue (created_at ASC)
  WHERE status = 'pending';

-- Gateway-side lookup when it polls for its enqueued task's result.
CREATE INDEX IF NOT EXISTS idx_worker_queue_finding
  ON public.dev_autopilot_worker_queue (finding_id, kind, created_at DESC);

-- Stuck-row watchdog scan.
CREATE INDEX IF NOT EXISTS idx_worker_queue_running
  ON public.dev_autopilot_worker_queue (started_at ASC)
  WHERE status = 'running';

COMMENT ON TABLE public.dev_autopilot_worker_queue IS
  'BOOTSTRAP-DEV-AUTOPILOT-WORKER-QUEUE: pending/running LLM tasks handed from the gateway to a local Claude-Code-authenticated worker so LLM calls go through the Claude subscription instead of the pay-per-token API.';

-- Service role only. No RLS policies required — the gateway and worker
-- both authenticate with SUPABASE_SERVICE_ROLE.
ALTER TABLE public.dev_autopilot_worker_queue ENABLE ROW LEVEL SECURITY;

-- updated_at trigger keeps last-touched visible to the watchdog + to anyone
-- eyeballing the queue in Supabase Studio.
CREATE OR REPLACE FUNCTION public.dev_autopilot_worker_queue_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_worker_queue_touch ON public.dev_autopilot_worker_queue;
CREATE TRIGGER trg_worker_queue_touch
  BEFORE UPDATE ON public.dev_autopilot_worker_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.dev_autopilot_worker_queue_touch_updated_at();

COMMIT;
