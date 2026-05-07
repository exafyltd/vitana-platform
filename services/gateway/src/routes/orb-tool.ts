/**
 * VTID-LIVEKIT-TOOL-DISPATCHER: HTTP wrapper around the canonical
 * orb-tool dispatcher in services/orb-tools-shared.ts.
 *
 * POST /api/v1/orb/tool
 *   Body: { name: string, args: object }
 *   Returns: { ok: boolean, result?: any, error?: string, vtid: string }
 *
 * The actual tool logic lives in services/gateway/src/services/orb-tools-shared.ts
 * so the Vertex pipeline (services/gateway/src/routes/orb-live.ts) and the
 * LiveKit pipeline can both call dispatchOrbTool() without divergence.
 * Per-tool drift bugs (search_events losing titles, search_community
 * querying a non-existent table, etc.) become impossible by construction
 * because both callers share the same module.
 */

import { Router, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import {
  dispatchOrbTool,
  type OrbToolArgs,
  type OrbToolIdentity,
} from '../services/orb-tools-shared';

const router = Router();
const VTID = 'VTID-LIVEKIT-TOOLS';

function adminClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

router.post('/orb/tool', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const name = String(req.body?.name ?? '').trim();
  const args = (req.body?.args ?? {}) as OrbToolArgs;
  if (!name) {
    return res.status(400).json({ ok: false, error: 'name is required', vtid: VTID });
  }
  const userId = req.identity?.user_id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  }
  const identity: OrbToolIdentity = {
    user_id: userId,
    tenant_id: req.identity?.tenant_id ?? null,
    role: req.identity?.role ?? null,
    vitana_id: req.identity?.vitana_id ?? null,
  };
  const sb = adminClient() || getSupabase();
  if (!sb) {
    return res.status(500).json({ ok: false, error: 'supabase_not_configured', vtid: VTID });
  }

  const r = await dispatchOrbTool(name, args, identity, sb);
  if ('ok' in r && r.ok === false && r.error?.startsWith('unknown tool:')) {
    return res.status(404).json({ ...r, vtid: VTID });
  }
  return res.status(200).json({ ...r, vtid: VTID });
});

export default router;
