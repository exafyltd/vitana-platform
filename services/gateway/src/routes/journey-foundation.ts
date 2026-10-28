/**
 * VTID-03255 — Journey Foundation HTTP surface (P1, read path).
 *
 * GET /api/v1/journey-foundation
 *   Returns the one shared JourneyFoundationSnapshot — the goal-gated, dual-axis
 *   (health + longevity economy) guided path. The voice greeting, the mobile
 *   "Meine Reise" screen, and the desktop /autopilot My Journey dashboard all
 *   read this same payload, so what Vitana drives and what the screen shows are
 *   always one system.
 *
 * POST /api/v1/journey-foundation/answer
 *   The write+delta path — used by non-voice surfaces (mobile/desktop) to
 *   record an answer the same way the `record_journey_answer` voice tool does.
 *   Returns the JourneyFoundationDelta so the screen refreshes + highlights.
 *
 * The voice tool (record_journey_answer) and the session-end summary writer
 * live alongside this. orb-live.ts owns none of this logic.
 */

import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { buildJourneyFoundationSnapshot } from '../services/journey-foundation/journey-foundation-state';
import {
  applyJourneyAnswer,
  type JourneyAnswerInput,
} from '../services/journey-foundation/journey-foundation-delta';

const router = Router();

const VTID = 'VTID-03255';

function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity?.user_id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  }

  const client = getServiceClient();
  if (!client) {
    return res.status(500).json({ ok: false, error: 'supabase_not_configured', vtid: VTID });
  }

  try {
    const snapshot = await buildJourneyFoundationSnapshot(client, userId);
    return res.json({ ok: true, snapshot, vtid: VTID });
  } catch (err: any) {
    console.error(`[${VTID}] journey-foundation snapshot failed: ${err?.message}`);
    return res.status(500).json({ ok: false, error: 'snapshot_failed', vtid: VTID });
  }
});

router.post('/answer', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity?.user_id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  }
  const step = String(req.body?.step ?? '').trim();
  if (!step) {
    return res.status(400).json({ ok: false, error: 'step_required', vtid: VTID });
  }

  const client = getServiceClient();
  if (!client) {
    return res.status(500).json({ ok: false, error: 'supabase_not_configured', vtid: VTID });
  }

  const input: JourneyAnswerInput = {
    step,
    value: req.body?.value != null ? String(req.body.value) : undefined,
    category: req.body?.category != null ? String(req.body.category) : null,
    target_value: req.body?.target_value != null ? Number(req.body.target_value) : null,
    target_unit: req.body?.target_unit != null ? String(req.body.target_unit) : null,
    target_date: req.body?.target_date != null ? String(req.body.target_date) : null,
    starting_value: req.body?.starting_value != null ? Number(req.body.starting_value) : null,
    acknowledged: req.body?.acknowledged !== false,
  };

  try {
    const delta = await applyJourneyAnswer(client, userId, input);
    return res.json({ ok: true, delta, vtid: VTID });
  } catch (err: any) {
    console.error(`[${VTID}] journey-foundation answer failed: ${err?.message}`);
    return res.status(500).json({ ok: false, error: 'answer_failed', vtid: VTID });
  }
});

export default router;
