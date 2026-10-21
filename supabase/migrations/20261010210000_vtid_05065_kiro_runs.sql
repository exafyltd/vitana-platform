-- VTID-05065 — Kiro runs: one server-side record per Kiro turn in the Command Hub
-- Operator, and the turn's events in order, so the console can always replay a turn
-- (reload, second tab, thread switch) and a gateway deploy leaves a visible
-- `interrupted` run instead of a lost one.
--
-- kiro_runs: one row per turn. The gateway task that runs it (`gateway_task`)
-- refreshes `last_heartbeat_at` every 30 s; any task's sweep marks another task's
-- unfinished run with a heartbeat older than 2 min `interrupted` (guarded UPDATE).
-- At most one running run per thread; queued ones wait in `created_at` order.
-- `pending_permission` holds the open approval card (null when none); an answer from
-- another gateway task is written onto it and picked up by the owning task.
--
-- kiro_run_events: the run's events, `seq` assigned by the owning task; message text
-- is coalesced (one event per 500 ms or 2 KB), so a typical turn is tens of rows.
--
-- Service role only: RLS on, no policies (the gateway reads and writes; no client
-- access). Holds the developer's own message and Kiro's reply for the admin-only
-- Operator Console; never keys or secrets.
-- impact-allow-solo-migration: new tables read and written only by the gateway in the same PR.

CREATE TABLE IF NOT EXISTS public.kiro_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id            text NOT NULL,
  user_id              text NOT NULL,
  status               text NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'running', 'waiting_permission', 'completed', 'refused',
                                         'incomplete', 'failed', 'cancelled', 'interrupted')),
  message              text NOT NULL DEFAULT '',
  reply                text,
  stop_reason          text,
  kiro_model           text,
  workspace            jsonb,
  error                text,
  pending_permission   jsonb,
  cancel_requested_at  timestamptz,
  gateway_task         text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  ended_at             timestamptz,
  last_heartbeat_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_kiro_runs_thread_created
  ON public.kiro_runs (thread_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kiro_runs_status_heartbeat
  ON public.kiro_runs (status, last_heartbeat_at);

CREATE TABLE IF NOT EXISTS public.kiro_run_events (
  id          bigserial PRIMARY KEY,
  run_id      uuid NOT NULL REFERENCES public.kiro_runs(id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  type        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kiro_run_events_run_seq_key UNIQUE (run_id, seq)
);

ALTER TABLE public.kiro_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kiro_run_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.kiro_runs FROM anon, authenticated;
REVOKE ALL ON public.kiro_run_events FROM anon, authenticated;

COMMENT ON TABLE public.kiro_runs IS
  'VTID-05065: one row per Kiro turn in the Command Hub Operator (status, reply, pending approval card, owning gateway task, heartbeat). Service role only (gateway).';
COMMENT ON TABLE public.kiro_run_events IS
  'VTID-05065: the events of a Kiro run in seq order (coalesced message text, tool calls, approval cards and answers, status changes), replayed by GET /api/v1/operator/kiro/runs/:id/stream. Service role only (gateway).';
COMMENT ON COLUMN public.kiro_runs.gateway_task IS
  'VTID-05065: the gateway process (random id at boot) that runs this turn and refreshes last_heartbeat_at every 30 s.';
COMMENT ON COLUMN public.kiro_runs.pending_permission IS
  'VTID-05065: the open approval card {request_id, tool_call_id, title, kind, expires_at[, answer]}; null when none.';
