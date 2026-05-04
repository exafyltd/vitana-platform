/**
 * VTID-01973: Intent matches REST router (P2-A).
 *
 *   GET   /api/v1/intent-matches/incoming     — where I'm vitana_id_b
 *   GET   /api/v1/intent-matches/outgoing     — where I'm vitana_id_a
 *   POST  /api/v1/intent-matches/:id/state    — lifecycle transition
 *   POST  /api/v1/intent-matches/:id/decline  — convenience
 */

import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import {
  requireAuth,
  requireTenant,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { tryUnlockReveal } from '../services/intent-mutual-reveal';
import { enrichMatchesWithCounterpartyProfiles } from '../services/intent-match-enrich';
import { notifyMutualInterest } from '../services/intent-notifier';
import { emitOasisEvent } from '../services/oasis-event-service';
import type { MatchRow } from '../services/intent-matcher';

const router = Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);
}

const VALID_TRANSITIONS = new Set([
  'viewed_by_a', 'viewed_by_b',
  'responded_by_a', 'responded_by_b',
  'mutual_interest', 'engaged', 'fulfilled', 'closed', 'declined',
]);

// ── GET /intent-matches/outgoing (I'm party A) ───────────────

router.get('/outgoing', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const supabase = getSupabase();

  // Find intents owned by the reader, then their matches.
  const { data: myIntents } = await supabase
    .from('user_intents')
    .select('intent_id')
    .eq('requester_user_id', identity.user_id);
  const myIds = (myIntents ?? []).map((r: any) => r.intent_id as string);
  if (myIds.length === 0) return res.json({ ok: true, matches: [] });

  const { data, error } = await supabase
    .from('intent_matches')
    .select('*')
    .in('intent_a_id', myIds)
    .order('score', { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ ok: false, error: error.message });

  const enriched = await enrichMatchesWithCounterpartyProfiles((data ?? []) as MatchRow[], identity.user_id);
  return res.json({ ok: true, matches: enriched });
});

// ── GET /intent-matches/incoming (I'm party B) ───────────────

router.get('/incoming', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const supabase = getSupabase();

  const { data: myIntents } = await supabase
    .from('user_intents')
    .select('intent_id')
    .eq('requester_user_id', identity.user_id);
  const myIds = (myIntents ?? []).map((r: any) => r.intent_id as string);
  if (myIds.length === 0) return res.json({ ok: true, matches: [] });

  const { data, error } = await supabase
    .from('intent_matches')
    .select('*')
    .in('intent_b_id', myIds)
    .order('score', { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ ok: false, error: error.message });

  const enriched = await enrichMatchesWithCounterpartyProfiles((data ?? []) as MatchRow[], identity.user_id);
  return res.json({ ok: true, matches: enriched });
});

// ── POST /intent-matches/:id/state ───────────────────────────

router.post('/:id/state', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const newState = String(req.body?.state ?? '');
  if (!VALID_TRANSITIONS.has(newState)) {
    return res.status(400).json({ ok: false, error: 'invalid_state', allowed: Array.from(VALID_TRANSITIONS) });
  }

  const supabase = getSupabase();
  const { data: m } = await supabase
    .from('intent_matches')
    .select('match_id, intent_a_id, intent_b_id, state, vitana_id_a, vitana_id_b, kind_pairing')
    .eq('match_id', req.params.id)
    .maybeSingle();
  if (!m) return res.status(404).json({ ok: false, error: 'not_found' });

  // Authorize: reader must own intent_a OR intent_b.
  const { data: aOwner } = await supabase
    .from('user_intents').select('requester_user_id').eq('intent_id', (m as any).intent_a_id).maybeSingle();
  const { data: bOwner } = (m as any).intent_b_id
    ? await supabase.from('user_intents').select('requester_user_id').eq('intent_id', (m as any).intent_b_id).maybeSingle()
    : { data: null as any };
  const isA = aOwner && (aOwner as any).requester_user_id === identity.user_id;
  const isB = bOwner && (bOwner as any).requester_user_id === identity.user_id;
  if (!isA && !isB) return res.status(403).json({ ok: false, error: 'not_a_party' });

  // Detect bilateral interest → mutual_interest.
  let computedNextState = newState;
  if ((newState === 'responded_by_a' && (m as any).state === 'responded_by_b')
    || (newState === 'responded_by_b' && (m as any).state === 'responded_by_a')) {
    computedNextState = 'mutual_interest';
  }

  const { error } = await supabase
    .from('intent_matches')
    .update({ state: computedNextState })
    .eq('match_id', req.params.id);
  if (error) return res.status(500).json({ ok: false, error: error.message });

  // If transitioned to mutual_interest, try the reveal protocol AND fire
  // bilateral push notifications + auto-thread seed (P2-B).
  if (computedNextState === 'mutual_interest') {
    await tryUnlockReveal(req.params.id);
    await notifyMutualInterest(req.params.id);
  }

  await emitOasisEvent({
    vtid: 'VTID-01973',
    type: 'voice.message.sent',
    source: 'intent-matches-route',
    status: 'info',
    message: `Match state -> ${computedNextState}`,
    payload: {
      match_id: req.params.id,
      from_state: (m as any).state,
      to_state: computedNextState,
      kind_pairing: (m as any).kind_pairing,
      mutual_unlocked: computedNextState === 'mutual_interest',
    },
    actor_id: identity.user_id,
    actor_role: 'user',
    surface: 'api',
    vitana_id: identity.vitana_id ?? undefined,
  });

  return res.json({ ok: true, state: computedNextState });
});

// ── POST /intent-matches/:id/decline ─────────────────────────

router.post('/:id/decline', requireAuth, requireTenant, async (req: Request, res: Response) => {
  // Convenience wrapper around state=declined. Inline the same authorize +
  // update + audit dance rather than re-routing internally.
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase = getSupabase();
  const { data: m } = await supabase
    .from('intent_matches')
    .select('match_id, intent_a_id, intent_b_id, state, kind_pairing')
    .eq('match_id', req.params.id)
    .maybeSingle();
  if (!m) return res.status(404).json({ ok: false, error: 'not_found' });

  const { data: aOwner } = await supabase
    .from('user_intents').select('requester_user_id').eq('intent_id', (m as any).intent_a_id).maybeSingle();
  const { data: bOwner } = (m as any).intent_b_id
    ? await supabase.from('user_intents').select('requester_user_id').eq('intent_id', (m as any).intent_b_id).maybeSingle()
    : { data: null as any };
  const isParty = (aOwner && (aOwner as any).requester_user_id === identity.user_id)
                || (bOwner && (bOwner as any).requester_user_id === identity.user_id);
  if (!isParty) return res.status(403).json({ ok: false, error: 'not_a_party' });

  const { error } = await supabase
    .from('intent_matches')
    .update({ state: 'declined' })
    .eq('match_id', req.params.id);
  if (error) return res.status(500).json({ ok: false, error: error.message });

  await emitOasisEvent({
    vtid: 'VTID-01973',
    type: 'voice.message.sent',
    source: 'intent-matches-route',
    status: 'info',
    message: `Match declined`,
    payload: { match_id: req.params.id, from_state: (m as any).state, kind_pairing: (m as any).kind_pairing },
    actor_id: identity.user_id,
    actor_role: 'user',
    surface: 'api',
    vitana_id: identity.vitana_id ?? undefined,
  });

  return res.json({ ok: true, state: 'declined' });
});

// ── POST /intent-matches/:id/dispute ─────────────────────────
// VTID-01976 (P2-C): raise a dispute on a match. Either party can raise;
// admin resolves via /api/v1/admin/intent-engine/disputes/* routes.

router.post('/:id/dispute', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const reasonCategory = String(req.body?.reason_category ?? '').trim();
  const reasonDetail = String(req.body?.reason_detail ?? '').trim();
  const allowedCategories = ['no_show', 'misrepresented', 'safety', 'payment', 'other'];
  if (!allowedCategories.includes(reasonCategory)) {
    return res.status(400).json({ ok: false, error: 'invalid_reason_category', allowed: allowedCategories });
  }
  if (reasonDetail.length < 10 || reasonDetail.length > 2000) {
    return res.status(400).json({ ok: false, error: 'reason_detail must be 10-2000 chars' });
  }

  try {
    const { raiseDispute } = await import('../services/intent-dispute-service');
    const dispute = await raiseDispute({
      match_id: req.params.id,
      raised_by: identity.user_id,
      reason_category: reasonCategory as any,
      reason_detail: reasonDetail,
      vitana_id_hint: identity.vitana_id ?? null,
    });
    return res.status(201).json({ ok: true, dispute });
  } catch (err: any) {
    const msg = err?.message ?? 'unknown';
    if (msg === 'match_not_found') return res.status(404).json({ ok: false, error: msg });
    if (msg === 'not_a_party') return res.status(403).json({ ok: false, error: msg });
    return res.status(500).json({ ok: false, error: msg });
  }
});

export default router;
