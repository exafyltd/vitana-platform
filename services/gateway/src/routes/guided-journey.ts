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
  recordListenedSession,
} from '../services/guided-journey/guided-journey-state';
import { recordSessionListen } from '../services/guided-journey/journey-index-award';
import { emitOasisEvent } from '../services/oasis-event-service';
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

// BOOTSTRAP-GUIDED-JOURNEY-POPUP — the user listened to a guided session.
// Fired when the user taps a session/topic and Vitana narrates it. Does TWO
// things, in priority order:
//   1) DURABLE PROGRESS (primary): advance `current_session` so the "Sitzung N"
//      ring reads from the account, not per-browser localStorage. This is the
//      fix for the ring resetting and for staging/production showing different
//      numbers for the same user — both now read the same server-side marker.
//   2) +2 VITANA INDEX AWARD (best-effort): idempotent per topic; replays never
//      double-award. Wrapped so a failure here (e.g. the awards ledger table not
//      yet provisioned) can NEVER fail the durable progress write above.
// POST /api/v1/journey/session-listened  { session, topicId? }
//   → { ok, awarded, points, current_session }.
router.post('/session-listened', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity?.user_id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: 'BOOTSTRAP-GUIDED-JOURNEY-POPUP' });
  }
  const session = Number(req.body?.session);
  const topicId = typeof req.body?.topicId === 'string' ? req.body.topicId.trim() : '';
  if (!Number.isInteger(session) || session <= 0) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_session',
      detail: 'session (positive integer) is required',
      vtid: 'BOOTSTRAP-GUIDED-JOURNEY-POPUP',
    });
  }
  const client = getSupabase();
  if (!client) {
    return res.status(500).json({ ok: false, error: 'supabase_not_configured', vtid: 'BOOTSTRAP-GUIDED-JOURNEY-POPUP' });
  }

  // 1) Durable progress — must succeed. A failure here is a real error.
  let state;
  try {
    state = await recordListenedSession(client, userId, session);
  } catch (err: any) {
    console.error(`[BOOTSTRAP-GUIDED-JOURNEY-POPUP] session-listened persist failed: ${err?.message}`);
    return res.status(500).json({ ok: false, error: 'session_listened_failed', vtid: 'BOOTSTRAP-GUIDED-JOURNEY-POPUP' });
  }

  // 2) +2 Vitana Index award — best-effort, keyed by topic. Never blocks or
  //    fails the durable progress write. Logged (not silenced) on failure.
  let awarded = false;
  let points = 0;
  let totalBonus = 0;
  if (topicId) {
    try {
      const result = await recordSessionListen(client, userId, topicId);
      awarded = result.awarded;
      points = result.points;
      totalBonus = result.totalBonus;
      if (result.awarded) {
        // Mirror the calendar path's `index.recomputed` event so the +2 surfaces
        // in the user's Index movement history. emitOasisEvent never throws.
        void emitOasisEvent({
          vtid: 'SYSTEM',
          type: 'index.recomputed' as any,
          source: 'guided-journey-api',
          actor_id: userId,
          surface: 'api',
          status: 'info',
          message: `Vitana Index +${result.points} for listening to a guided session (${topicId})`,
          payload: {
            user_id: userId,
            topic_id: topicId,
            delta_total: result.points,
            total_bonus: result.totalBonus,
            reason: 'guided_session_listen',
          },
        });
      }
    } catch (err: any) {
      console.warn(`[BOOTSTRAP-GUIDED-JOURNEY-POPUP] index award skipped (non-fatal): ${err?.message}`);
    }
  }

  return res.json({
    ok: true,
    awarded,
    points,
    total_bonus: totalBonus,
    current_session: state.currentSession,
    vtid: 'BOOTSTRAP-GUIDED-JOURNEY-POPUP',
  });
});

export default router;
