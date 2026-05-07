/**
 * VTID-LIVEKIT-AGENT-TRACE: runtime telemetry from the orb-agent into the
 * gateway so we can see what the agent has at session start without
 * touching Cloud Run logs.
 *
 *   POST /api/v1/orb/agent-trace  — agent posts a session-start trace
 *   GET  /api/v1/orb/agent-trace  — operator/diag panel reads the latest
 *                                    trace for the authenticated user.
 *
 * Backed by `oasis_events` so traces are visible across all Cloud Run
 * gateway instances (in-memory storage was instance-local; agent POST
 * landed on instance A, diag GET hit instance B → 404).
 */

import { Router, Request, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';

const router = Router();
const VTID = 'VTID-LIVEKIT-AGENT-TRACE';
const TRACE_TOPIC = 'livekit.agent.session.trace';

// Service-role client — needed because the agent POSTs without a user JWT
// and we still want to write the trace row.
function getAdmin(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * POST /api/v1/orb/agent-trace — agent → gateway write
 *
 * No auth middleware. The agent calls this with the per-session user JWT,
 * but the trace endpoint only needs the body's user_id field — the trace
 * is observability, not a user-scoped write. Stores into oasis_events
 * with topic = 'livekit.agent.session.trace'.
 */
router.post('/orb/agent-trace', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const userId = String(body.user_id ?? '').trim();
  if (!userId) {
    return res.status(400).json({ ok: false, error: 'user_id required', vtid: VTID });
  }

  const sb = getAdmin();
  if (!sb) {
    return res.status(503).json({ ok: false, error: 'supabase_not_configured', vtid: VTID });
  }

  try {
    const { error } = await sb.from('oasis_events').insert({
      topic: TRACE_TOPIC,
      vtid: VTID,
      source: 'orb-agent',
      service: 'orb-agent',
      role: 'orb-agent',
      status: 'info',
      message: `LiveKit agent session trace for ${userId}`,
      metadata: body,
      created_at: new Date().toISOString(),
    });
    if (error) {
      console.warn('[orb-agent-trace] insert failed:', error.message);
      return res
        .status(500)
        .json({ ok: false, error: `insert failed: ${error.message}`, vtid: VTID });
    }
    return res.json({ ok: true, vtid: VTID });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown';
    console.warn('[orb-agent-trace] insert exception:', msg);
    return res.status(500).json({ ok: false, error: msg, vtid: VTID });
  }
});

/**
 * GET /api/v1/orb/agent-trace — diag panel → gateway read
 *
 * Authenticated. Returns the latest trace for the calling user_id (from
 * req.identity.user_id). 404 if no trace within the last 1 hour window.
 */
router.get('/orb/agent-trace', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity?.user_id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  }
  const sb = getAdmin();
  if (!sb) {
    return res.status(503).json({ ok: false, error: 'supabase_not_configured', vtid: VTID });
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  try {
    const { data, error } = await sb
      .from('oasis_events')
      .select('id, topic, metadata, created_at')
      .eq('topic', TRACE_TOPIC)
      .filter('metadata->>user_id', 'eq', userId)
      .gte('created_at', oneHourAgo)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) {
      return res.status(500).json({ ok: false, error: error.message, vtid: VTID });
    }
    if (!data || data.length === 0) {
      return res.status(404).json({ ok: false, error: 'no_recent_trace', vtid: VTID });
    }
    const row = data[0];
    return res.json({
      ok: true,
      trace: {
        ts: row.created_at,
        user_id: userId,
        payload: row.metadata as Record<string, unknown>,
      },
      vtid: VTID,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown';
    return res.status(500).json({ ok: false, error: msg, vtid: VTID });
  }
});

/**
 * GET /api/v1/orb/agent-trace/recent — debug-only firehose
 *
 * Returns the last N traces across ALL users. Public; no auth. Used to
 * verify whether the agent is posting heartbeats at all (the per-user
 * GET filters by req.identity.user_id and would 404 even if the agent
 * is posting under a different user_id like "agent-heartbeat").
 *
 * Data exposed: timestamps, code_version, user_id (truncated), prompt
 * length. No tokens, no facts. Safe for unauthenticated read.
 */
router.get('/orb/agent-trace/recent', async (_req: Request, res: Response) => {
  const sb = getAdmin();
  if (!sb) {
    return res.status(503).json({ ok: false, error: 'supabase_not_configured', vtid: VTID });
  }
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  try {
    const { data, error } = await sb
      .from('oasis_events')
      .select('id, topic, metadata, created_at')
      .eq('topic', TRACE_TOPIC)
      .gte('created_at', oneHourAgo)
      .order('created_at', { ascending: false })
      .limit(15);
    if (error) {
      return res.status(500).json({ ok: false, error: error.message, vtid: VTID });
    }
    const rows = (data || []).map((r) => {
      const md = (r.metadata as Record<string, unknown>) || {};
      const uid = String(md.user_id ?? '');
      return {
        ts: r.created_at,
        user_id_short: uid.slice(0, 12),
        code_version: md.code_version ?? null,
        phase: md.phase ?? null,
        error: md.error ?? null,
        greeting_text: md.greeting_text ?? null,
        vitana_id: md.vitana_id ?? null,
        bootstrap_context_length: md.bootstrap_context_length ?? null,
        system_prompt_length: md.system_prompt_length ?? null,
        tools_count: md.tools_count ?? null,
        tools_handle_in_first_chars: md.tools_handle_in_first_chars ?? null,
      };
    });
    return res.json({ ok: true, count: rows.length, rows, vtid: VTID });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown';
    return res.status(500).json({ ok: false, error: msg, vtid: VTID });
  }
});

export default router;
