/**
 * VTID-04319 (Orchestrator v2, P1): read-only control-plane API
 * (docs/ORCHESTRATOR-REDESIGN-PLAN.md §3).
 *
 *   GET /api/v1/orchestrator/context        — the caller's own resolved context (any signed-in user)
 *   GET /api/v1/orchestrator/runs           — unified runs across planes (exafy_admin)
 *   GET /api/v1/orchestrator/runs/summary   — per-plane counts over a window (exafy_admin)
 *   GET /api/v1/orchestrator/agents         — agent cards from agents_registry (exafy_admin)
 *   GET /api/v1/orchestrator/policy         — default grants + the caller's own ceilings,
 *                                             optional ?domain=&tier= dry evaluation (VTID-04325,
 *                                             shadow: nothing enforces it yet)
 *   GET /api/v1/orchestrator/policy/shadow  — what the policy WOULD have decided for real ORB
 *                                             tool calls since this process started, plus the
 *                                             tool catalog summary (VTID-04362, exafy_admin)
 *
 * Nothing here writes or changes any plane's behaviour.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { resolveAgentContext } from '../services/orchestrator/context';
import {
  listUnifiedRuns,
  normalizeRunQuery,
  summarizeRuns,
  listAgentCards,
} from '../services/orchestrator/run-ledger';
import {
  ceilingsFor,
  evaluatePolicy,
  isPolicyDomain,
  isPolicyTier,
  policyDefaults,
} from '../services/orchestrator/policy';
import { shadowSnapshot } from '../services/orchestrator/policy-shadow';
import { buildToolCatalog, summarizeCatalog } from '../services/orchestrator/tool-catalog';

const router = Router();

async function requireDevRole(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (process.env.GATEWAY_INTERNAL_TOKEN && req.get('X-Gateway-Internal') === process.env.GATEWAY_INTERNAL_TOKEN) {
    return next();
  }
  await requireAuth(req as AuthenticatedRequest, res, () => {
    const identity = (req as AuthenticatedRequest).identity;
    if (!identity) {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      return;
    }
    if (identity.exafy_admin !== true) {
      res.status(403).json({ ok: false, error: 'Orchestrator view requires developer access (exafy_admin)' });
      return;
    }
    next();
  });
}

function db(res: Response) {
  const sb = getSupabase();
  if (!sb) res.status(503).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
  return sb;
}

router.get('/context', requireAuth as any, async (req: Request, res: Response) => {
  const identity = (req as AuthenticatedRequest).identity;
  if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const sb = db(res);
  if (!sb) return;
  const q = req.query as Record<string, unknown>;
  const context = await resolveAgentContext(sb, {
    user_id: identity.user_id,
    tenant_id: identity.tenant_id,
    exafy_admin: identity.exafy_admin,
    current_route: typeof q.route === 'string' ? q.route : null,
    explicit_surface: typeof q.surface === 'string' ? q.surface : null,
    channel: typeof q.channel === 'string' ? q.channel : 'web',
    locale: typeof q.locale === 'string' ? q.locale : null,
  });
  return res.json({ ok: true, data: context });
});

router.get('/runs', requireDevRole, async (req: Request, res: Response) => {
  const sb = db(res);
  if (!sb) return;
  const q = normalizeRunQuery(req.query as Record<string, unknown>);
  const { runs, error } = await listUnifiedRuns(sb, q);
  if (error) return res.status(502).json({ ok: false, error });
  return res.json({ ok: true, data: { runs, query: q } });
});

router.get('/runs/summary', requireDevRole, async (req: Request, res: Response) => {
  const sb = db(res);
  if (!sb) return;
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { planes, truncated, error } = await summarizeRuns(sb, since);
  if (error) return res.status(502).json({ ok: false, error });
  return res.json({ ok: true, data: { since, days, truncated, planes } });
});

router.get('/agents', requireDevRole, async (_req: Request, res: Response) => {
  const sb = db(res);
  if (!sb) return;
  const { agents, error } = await listAgentCards(sb);
  if (error) return res.status(502).json({ ok: false, error });
  return res.json({ ok: true, data: { agents } });
});

router.get('/policy/shadow', requireDevRole, async (_req: Request, res: Response) => {
  let catalog: { tools: number; unclassified: string[]; by_domain_tier: Record<string, Record<string, number>> } | null = null;
  try {
    // Loaded lazily: the ORB tool registry is large and this route is rarely hit.
    const { ORB_TOOL_NAMES } = await import('../services/orb-tools-shared');
    const built = buildToolCatalog(ORB_TOOL_NAMES);
    catalog = {
      tools: ORB_TOOL_NAMES.length,
      unclassified: Object.entries(built).filter(([, c]) => c.source === 'default').map(([n]) => n),
      by_domain_tier: summarizeCatalog(built),
    };
  } catch (e: unknown) {
    console.warn('[orchestrator] tool catalog unavailable:', e instanceof Error ? e.message : e);
  }
  return res.json({ ok: true, data: { shadow: shadowSnapshot(), catalog } });
});

router.get('/policy', requireAuth as any, async (req: Request, res: Response) => {
  const identity = (req as AuthenticatedRequest).identity;
  if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const q = req.query as Record<string, unknown>;
  if (q.domain !== undefined && !isPolicyDomain(q.domain)) {
    return res.status(400).json({ ok: false, error: 'INVALID_DOMAIN' });
  }
  if (q.tier !== undefined && !isPolicyTier(q.tier)) {
    return res.status(400).json({ ok: false, error: 'INVALID_TIER' });
  }
  const sb = db(res);
  if (!sb) return;
  const context = await resolveAgentContext(sb, {
    user_id: identity.user_id,
    tenant_id: identity.tenant_id,
    exafy_admin: identity.exafy_admin,
    current_route: typeof q.route === 'string' ? q.route : null,
    explicit_surface: typeof q.surface === 'string' ? q.surface : null,
    channel: typeof q.channel === 'string' ? q.channel : 'web',
    locale: null,
  });
  const evaluation = isPolicyDomain(q.domain)
    ? evaluatePolicy(context, q.domain, isPolicyTier(q.tier) ? q.tier : 'read')
    : null;
  return res.json({
    ok: true,
    data: {
      defaults: policyDefaults(),
      platform_role: context.platform_role,
      channel: context.channel,
      ceilings: ceilingsFor(context),
      evaluation,
    },
  });
});

export default router;
