/**
 * Pillar Agents — admin + self routes.
 *
 * Mounted at /api/v1/pillar-agents.
 *
 * Endpoints:
 *   GET  /health             — router liveness + list of registered agents
 *   POST /run                — run all 5 agents for the authenticated user
 *                              (or for any user if caller is exafy_admin)
 *                              Body: { user_id?: string, date?: string }
 *   GET  /outputs            — self read-only: list the caller's recent
 *                              per-pillar agent outputs (auth required)
 */

import { Router, Response } from 'express';
import { requireAuth, requireExafyAdmin, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { runPillarAgentsForUser, buildAllAgents } from '../services/pillar-agents/orchestrator';
import * as repo from './pillar-agents-repository';

const router = Router();

router.get('/health', (_req, res: Response) => {
  const supabase = getSupabase();
  const agents = supabase ? buildAllAgents(supabase).map(a => ({
    agent_id: a.agentId,
    pillar: a.pillar,
    version: a.version,
    display_name: a.displayName,
  })) : [];
  res.status(200).json({
    ok: true,
    service: 'pillar-agents',
    agent_count: agents.length,
    agents,
  });
});

router.post('/run', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  }

  const selfId = req.identity?.user_id;
  if (!selfId) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const requestedUser = (req.body?.user_id as string | undefined)?.trim();
  const date = (req.body?.date as string | undefined)?.trim()
    || new Date().toISOString().slice(0, 10);

  // Users can only run for themselves; exafy admins can run for any user.
  let targetUser = selfId;
  if (requestedUser && requestedUser !== selfId) {
    if (!req.identity?.exafy_admin) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    targetUser = requestedUser;
  }

  try {
    const result = await runPillarAgentsForUser(supabase, targetUser, date);
    return res.status(200).json(result);
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/outputs', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  }
  const userId = req.identity?.user_id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }
  const date = (req.query.date as string | undefined)?.trim()
    || new Date().toISOString().slice(0, 10);

  try {
    const { data, error } = await repo.fetchPillarAgentOutputsForUserDate(supabase, userId, date);
    if (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
    return res.status(200).json({ ok: true, user_id: userId, date, outputs: data ?? [] });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Admin-only: run for any user, and inspect recent outputs across users.
router.get('/admin/outputs', requireAuth, requireExafyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const limit = Math.min(100, Number(req.query.limit ?? 20));
  try {
    const { data, error } = await repo.fetchRecentPillarAgentOutputsAdmin(supabase, limit);
    if (error) return res.status(400).json({ ok: false, error: error.message });
    return res.status(200).json({ ok: true, outputs: data ?? [] });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
