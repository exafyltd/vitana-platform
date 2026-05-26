/**
 * VTID-03152 — Goal plan API (Slice E).
 *
 *   POST /api/v1/goal-plan/generate        → Vitana generates the plan for the
 *                                            user's active goal (supersedes prior)
 *   GET  /api/v1/goal-plan                 → active plan + steps + live day/days-left
 *   POST /api/v1/goal-plan/steps/:id/complete  → mark a step done (body: { done })
 *
 * Deploy marker: re-trigger AUTO-DEPLOY so /api/v1/goal-plan ships to the gateway.
 */

import { Router, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { generateGoalPlan, getGoalPlan, setStepStatus } from '../services/journey/goal-planner-service';

const router = Router();
const VTID = 'VTID-03152';

function getServiceClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

router.post('/generate', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity?.user_id;
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  const client = getServiceClient();
  if (!client) return res.status(503).json({ ok: false, error: 'supabase_unavailable', vtid: VTID });

  try {
    const result = await generateGoalPlan(client, userId);
    if (!result) {
      // No goal/deadline yet, or generation failed — let the client fall back gracefully.
      return res.status(200).json({ ok: false, error: 'no_plan_generated', vtid: VTID, plan: null });
    }
    const plan = await getGoalPlan(client, userId);
    return res.status(200).json({ ok: true, vtid: VTID, plan_id: result.plan_id, step_count: result.step_count, plan });
  } catch (err: any) {
    console.error('[VTID-03152] POST /goal-plan/generate:', err.message);
    return res.status(500).json({ ok: false, error: 'internal_error', vtid: VTID });
  }
});

router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity?.user_id;
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  const client = getServiceClient();
  if (!client) return res.status(503).json({ ok: false, error: 'supabase_unavailable', vtid: VTID });

  try {
    const plan = await getGoalPlan(client, userId);
    return res.status(200).json({ ok: true, vtid: VTID, plan });
  } catch (err: any) {
    console.error('[VTID-03152] GET /goal-plan:', err.message);
    return res.status(500).json({ ok: false, error: 'internal_error', vtid: VTID });
  }
});

router.post('/steps/:id/complete', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity?.user_id;
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  const client = getServiceClient();
  if (!client) return res.status(503).json({ ok: false, error: 'supabase_unavailable', vtid: VTID });

  const stepId = req.params.id;
  const done = req.body?.done !== false; // default to marking done
  try {
    const ok = await setStepStatus(client, userId, stepId, done ? 'done' : 'pending');
    return res.status(ok ? 200 : 500).json({ ok, vtid: VTID });
  } catch (err: any) {
    console.error('[VTID-03152] POST /goal-plan/steps/:id/complete:', err.message);
    return res.status(500).json({ ok: false, error: 'internal_error', vtid: VTID });
  }
});

export default router;
