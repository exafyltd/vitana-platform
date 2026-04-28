/**
 * VTID-02026 — Phase 6a — admin smoke endpoint for the Memory Broker.
 *
 * Lets exafy_admin call `getMemoryContext()` directly with a concrete
 * (tenant_id, user_id, intent) and inspect the resulting MemoryPack.
 * Used to verify Phase 6a end-to-end before any consumer wiring.
 *
 * Will be removed (or moved behind a stricter gate) in Phase 6c once the
 * broker is wired into context-pack-builder + retrieval-router.
 *
 * GET  /api/v1/admin/memory/context?tenant_id=...&user_id=...&intent=recall_history
 * POST /api/v1/admin/memory/context  (same args in body, plus required_blocks)
 */

import { Router, Response } from 'express';
import {
  requireAuth,
  requireExafyAdmin,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { getMemoryContext, MemoryIntent, MemoryBlockKind } from '../services/memory-broker';

const router = Router();
// VTID-02032: Path-scoped auth — was `router.use(requireAuth)` which fired
// for every /api/v1/* request because this router is mounted at /api/v1.
// That intercepts unrelated public endpoints and 401s them. Restrict to
// the actual admin paths.
router.use('/admin/memory', requireAuth);
router.use('/admin/memory', requireExafyAdmin);

const VALID_INTENTS: MemoryIntent[] = [
  'recall_recent',
  'recall_history',
  'identity',
  'plan_next_action',
  'open_session',
  'health_query',
  'index_status',
  'goal_check',
  'social_query',
  'community_intent',
  'system_introspect',
];

router.get('/admin/memory/context', async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = String(req.query.tenant_id || '');
  const userId   = String(req.query.user_id   || '');
  const intent   = String(req.query.intent    || 'recall_history') as MemoryIntent;
  const budget   = req.query.budget_ms ? Number(req.query.budget_ms) : 1500;

  if (!tenantId || !userId) {
    return res.status(400).json({ ok: false, error: 'tenant_id and user_id are required' });
  }
  if (!VALID_INTENTS.includes(intent)) {
    return res.status(400).json({ ok: false, error: `unknown intent: ${intent}` });
  }

  const pack = await getMemoryContext({
    tenant_id: tenantId,
    user_id: userId,
    intent,
    channel: 'admin',
    role: 'admin',
    latency_budget_ms: budget,
  });

  return res.json(pack);
});

router.post('/admin/memory/context', async (req: AuthenticatedRequest, res: Response) => {
  const body = req.body || {};
  const tenantId = String(body.tenant_id || '');
  const userId   = String(body.user_id   || '');
  const intent   = String(body.intent    || 'recall_history') as MemoryIntent;
  const budget   = typeof body.latency_budget_ms === 'number' ? body.latency_budget_ms : 1500;
  const requiredBlocks = Array.isArray(body.required_blocks)
    ? (body.required_blocks as MemoryBlockKind[])
    : undefined;

  if (!tenantId || !userId) {
    return res.status(400).json({ ok: false, error: 'tenant_id and user_id are required' });
  }
  if (!VALID_INTENTS.includes(intent)) {
    return res.status(400).json({ ok: false, error: `unknown intent: ${intent}` });
  }

  const pack = await getMemoryContext({
    tenant_id: tenantId,
    user_id: userId,
    intent,
    channel: 'admin',
    role: 'admin',
    latency_budget_ms: budget,
    required_blocks: requiredBlocks,
  });

  return res.json(pack);
});

export default router;
