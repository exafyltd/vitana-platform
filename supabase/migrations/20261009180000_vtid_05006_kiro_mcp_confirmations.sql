-- VTID-05006 — the in-thread Allow/Deny for every write a Kiro session asks the
-- Operator's tools to do (PRs, merges, autopilot runs, approvals, branch pushes).
--
-- One row per write call. The gateway's MCP route inserts it 'pending', holds
-- the call and polls the row; the signed-in user answers from the Kiro thread
-- in the Command Hub (POST /api/v1/operator/kiro/confirmations/:id), which only
-- moves a 'pending' row of their own. If the call goes away first (Kiro gave up,
-- the connection closed) the gateway marks it 'expired', and a late answer
-- changes nothing. DB-backed so it works across gateway tasks (ALB stickiness off).
--
-- Service role only: RLS on, no policies. Holds a short, human-readable summary
-- of the call, never secrets or file contents.
-- impact-allow-solo-migration: new table read and written only by the gateway in the same PR.

CREATE TABLE IF NOT EXISTS public.kiro_mcp_confirmations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  thread_id   text NOT NULL,
  tool        text NOT NULL,
  vtid        text,
  summary     text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'allowed', 'denied', 'expired')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_kiro_mcp_confirmations_pending
  ON public.kiro_mcp_confirmations (user_id, thread_id, created_at DESC)
  WHERE status = 'pending';

ALTER TABLE public.kiro_mcp_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.kiro_mcp_confirmations FROM anon, authenticated;

COMMENT ON TABLE public.kiro_mcp_confirmations IS
  'VTID-05006: Allow/Deny for each Kiro write tool call. Service role only (gateway).';
