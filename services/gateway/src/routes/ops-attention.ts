/**
 * VTID-04876 — GET /api/v1/ops/attention: the Command Hub Overview's
 * supervisor cockpit feed (plan A, Phase 1).
 *
 * Platform exafy_admin only (requireAdminAuth, plan F3): tenant admins never
 * see cross-tenant operations data. Read-only apart from the gateway's own
 * ops_attention_state bookkeeping (service role). Computed on demand while a
 * viewer has the Overview open, single-flight + 25 s cache per task
 * (services/ops-attention.ts). The Overview is a triage surface; GChat (SNS)
 * stays the paging channel.
 *
 * Response: { ok, data: { generated_at, env, verdict, counts, sources, items } }.
 */

import { Router, Response } from 'express';
import { requireAdminAuth, type AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getOpsAttention } from '../services/ops-attention';

const router = Router();

router.get('/', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
    const { data, cached } = await getOpsAttention({ authHeader });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, data, cached });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ops-attention] failed:', message);
    return res.status(500).json({ ok: false, error: 'attention_failed', data: null });
  }
});

export default router;
