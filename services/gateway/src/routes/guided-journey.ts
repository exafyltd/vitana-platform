/**
 * VTID-03276 — Guided Journey HTTP surface (P1).
 *
 *   GET  /api/v1/journey/state   → full durable JourneyState (creates row lazily)
 *   GET  /api/v1/journey/mode    → { mode } only
 *   POST /api/v1/journey/mode    → { mode: 'guided' | 'full' } applies the
 *                                  lossless switch rules, returns the new state
 *
 * Mode is PRODUCT/UX state. These routes never read or write subscription or
 * feature-permission state. Per-topic progress + practice-completion writes land
 * with the catalog (P5/P7).
 */

import { Router, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import {
  getJourneyState,
  setJourneyMode,
  completePractice,
} from '../services/guided-journey/guided-journey-state';
import type { JourneyMode } from '../types/guided-journey';

const router = Router();

const VTID = 'VTID-03276';

const VALID_MODES: readonly JourneyMode[] = ['guided', 'full'];

router.get('/state', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity?.user_id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  }
  const client = getSupabase();
  if (!client) {
    return res.status(500).json({ ok: false, error: 'supabase_not_configured', vtid: VTID });
  }
  try {
    const state = await getJourneyState(client, userId);
    return res.json({ ok: true, state, vtid: VTID });
  } catch (err: any) {
    console.error(`[${VTID}] get journey state failed: ${err?.message}`);
    return res.status(500).json({ ok: false, error: 'state_failed', vtid: VTID });
  }
});

router.get('/mode', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity?.user_id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  }
  const client = getSupabase();
  if (!client) {
    return res.status(500).json({ ok: false, error: 'supabase_not_configured', vtid: VTID });
  }
  try {
    const state = await getJourneyState(client, userId);
    return res.json({ ok: true, mode: state.mode, vtid: VTID });
  } catch (err: any) {
    console.error(`[${VTID}] get journey mode failed: ${err?.message}`);
    return res.status(500).json({ ok: false, error: 'mode_failed', vtid: VTID });
  }
});

router.post('/mode', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity?.user_id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  }
  const mode = req.body?.mode as unknown;
  if (typeof mode !== 'string' || !VALID_MODES.includes(mode as JourneyMode)) {
    return res
      .status(400)
      .json({ ok: false, error: 'invalid_mode', detail: "mode must be 'guided' or 'full'", vtid: VTID });
  }
  const client = getSupabase();
  if (!client) {
    return res.status(500).json({ ok: false, error: 'supabase_not_configured', vtid: VTID });
  }
  try {
    const state = await setJourneyMode(client, userId, mode as JourneyMode);
    return res.json({ ok: true, state, vtid: VTID });
  } catch (err: any) {
    console.error(`[${VTID}] set journey mode failed: ${err?.message}`);
    return res.status(500).json({ ok: false, error: 'set_mode_failed', vtid: VTID });
  }
});

// VTID-03282 (P7) — record a completed guided-practice action for a topic.
// POST /api/v1/journey/practice-complete  { topicId } → updated JourneyState.
router.post('/practice-complete', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity?.user_id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: 'VTID-03282' });
  }
  const topicId = req.body?.topicId as unknown;
  if (typeof topicId !== 'string' || !topicId.trim()) {
    return res
      .status(400)
      .json({ ok: false, error: 'invalid_topic_id', detail: 'topicId is required', vtid: 'VTID-03282' });
  }
  const client = getSupabase();
  if (!client) {
    return res.status(500).json({ ok: false, error: 'supabase_not_configured', vtid: 'VTID-03282' });
  }
  try {
    const state = await completePractice(client, userId, topicId);
    return res.json({ ok: true, state, vtid: 'VTID-03282' });
  } catch (err: any) {
    console.error(`[VTID-03282] practice-complete failed: ${err?.message}`);
    return res.status(500).json({ ok: false, error: 'practice_complete_failed', vtid: 'VTID-03282' });
  }
});

export default router;
