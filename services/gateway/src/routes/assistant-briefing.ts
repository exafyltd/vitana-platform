/**
 * Assistant briefing routes (VTID-ASSISTANT-ROLES).
 *
 *   GET /api/v1/assistant/briefing/developer
 *       — platform briefing for the developer assistant lane.
 *       Auth: requireAuth (Bearer JWT) + role gate: caller must be
 *       exafy_admin OR have active_role developer/admin in their tenant
 *       (mirror of developerGate()).
 *       Query: ?since=<ISO> (last-session time; default 24 h window).
 *
 *   GET /api/v1/assistant/briefing/admin/:tenantId
 *       — tenant-scoped briefing for the admin assistant lane.
 *       Auth: requireTenantAdmin (exafy_admin bypasses; tenant admin only
 *       for their own tenant — cross-tenant → 403).
 *       Query: ?since=<ISO>.
 *
 * Responses are the shared BriefingEnvelope, plus `rendered` (the prompt
 * block) so callers that inject into a system instruction don't re-render.
 * Payloads are developer/admin-facing operational data — English by design.
 */

import { Router, type Response } from 'express';
import {
  requireAuth,
  type AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { requireTenantAdmin } from '../middleware/require-tenant-admin';
import { getSupabase } from '../lib/supabase';
import {
  buildDeveloperBriefing,
  renderDeveloperBriefingBlock,
} from '../services/assistant-briefing/developer-briefing-service';
import {
  buildAdminBriefing,
  renderAdminBriefingBlock,
} from '../services/assistant-briefing/admin-briefing-service';

const router = Router();

const DEVELOPER_BRIEFING_ROLES = new Set(['developer', 'admin']);

function parseSince(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

router.get('/developer', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const identity = req.identity;
    if (!identity) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }

    let allowed = identity.exafy_admin === true;
    if (!allowed && identity.tenant_id) {
      const sb = getSupabase();
      if (sb) {
        const { data } = await sb
          .from('user_tenants')
          .select('active_role')
          .eq('user_id', identity.user_id)
          .eq('tenant_id', identity.tenant_id)
          .maybeSingle();
        allowed = DEVELOPER_BRIEFING_ROLES.has(String(data?.active_role ?? '').toLowerCase());
      }
    }
    if (!allowed) {
      return res.status(403).json({ ok: false, error: 'developer_role_required' });
    }

    const envelope = await buildDeveloperBriefing(parseSince(req.query.since));
    return res.json({ ...envelope, rendered: renderDeveloperBriefingBlock(envelope) });
  } catch (err: any) {
    console.error('[assistant-briefing] developer briefing failed:', err?.message || err);
    return res.status(500).json({ ok: false, error: 'briefing_failed' });
  }
});

router.get('/admin/:tenantId', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = String(req.params.tenantId || '').trim();
    if (!tenantId) {
      return res.status(400).json({ ok: false, error: 'tenant_id_required' });
    }
    const envelope = await buildAdminBriefing(tenantId, parseSince(req.query.since));
    return res.json({ ...envelope, rendered: renderAdminBriefingBlock(envelope) });
  } catch (err: any) {
    console.error('[assistant-briefing] admin briefing failed:', err?.message || err);
    return res.status(500).json({ ok: false, error: 'briefing_failed' });
  }
});

export default router;
