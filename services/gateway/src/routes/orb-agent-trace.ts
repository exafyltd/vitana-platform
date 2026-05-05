/**
 * VTID-LIVEKIT-AGENT-TRACE: runtime telemetry from the orb-agent into the
 * gateway so we can see what the agent has at session start without
 * touching Cloud Run logs.
 *
 *   POST /api/v1/orb/agent-trace  — agent posts a session-start trace
 *   GET  /api/v1/orb/agent-trace  — operator/diag panel reads the latest
 *                                    trace for the authenticated user.
 *
 * Stored in-memory in a per-user Map; capped + TTL'd. Sufficient for
 * the diag-loop use case (operator clicks Connect, then clicks Run
 * Diagnostics within ~30s and reads the trace). Persisted observability
 * goes through OASIS in a follow-up.
 */

import { Router, Request, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';

const router = Router();
const VTID = 'VTID-LIVEKIT-AGENT-TRACE';

interface TraceEntry {
  ts: string;
  user_id: string;
  payload: Record<string, unknown>;
}

// Per-user latest trace. Map preserves insertion order for the few-user
// staging environment; we only ever serve the latest entry per user.
const TRACE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const traces = new Map<string, TraceEntry>();

function cleanup(): void {
  const now = Date.now();
  for (const [k, v] of traces) {
    if (now - new Date(v.ts).getTime() > TRACE_TTL_MS) {
      traces.delete(k);
    }
  }
}

/**
 * POST /api/v1/orb/agent-trace — agent → gateway write
 *
 * Service-token (or any valid Bearer JWT) auth. The agent calls this
 * with its own service token; user identity comes from the body's
 * user_id field, NOT req.identity, because the agent isn't acting as
 * the user. The body shape is open-ended; the diag panel renders
 * whatever fields are present.
 *
 * Expected payload from session.py at session start:
 *   {
 *     user_id, tenant_id, vitana_id, role, lang,
 *     orb_session_id, agent_id, is_reconnect, is_anonymous,
 *     user_jwt_present, user_jwt_sub, bootstrap_context_length,
 *     bootstrap_has_vitana_id, bootstrap_voice_config_llm,
 *     system_prompt_length, system_prompt_first_400_chars,
 *     tools_count, tools_first_5,
 *   }
 */
router.post('/orb/agent-trace', async (req: Request, res: Response) => {
  cleanup();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const userId = String(body.user_id ?? '').trim();
  if (!userId) {
    return res.status(400).json({ ok: false, error: 'user_id required', vtid: VTID });
  }
  traces.set(userId, {
    ts: new Date().toISOString(),
    user_id: userId,
    payload: body,
  });
  return res.json({ ok: true, vtid: VTID });
});

/**
 * GET /api/v1/orb/agent-trace — diag panel → gateway read
 *
 * Authenticated. Returns the latest trace for the calling user_id (from
 * req.identity.user_id). 404 if no trace within the TTL window.
 */
router.get('/orb/agent-trace', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  cleanup();
  const userId = req.identity?.user_id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  }
  const entry = traces.get(userId);
  if (!entry) {
    return res.status(404).json({ ok: false, error: 'no_recent_trace', vtid: VTID });
  }
  return res.json({ ok: true, trace: entry, vtid: VTID });
});

export default router;
