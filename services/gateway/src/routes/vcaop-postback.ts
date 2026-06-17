/**
 * VCAOP affiliate postback receiver (PUBLIC, key-verified — NO user auth).
 *
 * Affiliate networks (Admitad first) call this server-to-server when a purchase
 * converts. Flow:
 *   1. Verify the shared key (ADMITAD_POSTBACK_KEY) — fail closed if unset.
 *   2. Resolve the per-user `subid` back to the member via `subid_map`
 *      (written at affiliate-link generation time).
 *   3. Idempotently upsert the commission_event (keyed by network+order so a
 *      network's retry storm never double-credits) and move the rewards_ledger
 *      entry pending -> confirmed (approved) | reversed (declined).
 *
 * Mounted OUTSIDE the authed vcaop router (a server postback has no user JWT).
 * Never throws on a network retry — unknown subids are parked (HTTP 202) so the
 * network stops retrying, and surfaced as an OASIS warning for reconciliation.
 */
import { Router, Request, Response } from 'express';
import { randomUUID, createHash, timingSafeEqual } from 'crypto';
import { getSupabase } from '../lib/supabase';

const router = Router();

/** Member share of the gross commission (mirrors the /shop 50% split). */
const MEMBER_SHARE = 0.5;

export function keyOk(provided: string): boolean {
  const expected = process.env.ADMITAD_POSTBACK_KEY || '';
  if (!expected || !provided) return false; // fail closed when unconfigured
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Map an affiliate-network status string to our ledger state. */
export function mapStatus(raw: string): 'pending' | 'confirmed' | 'reversed' {
  const s = (raw || '').toLowerCase().trim();
  if (['approved', 'confirmed', 'paid', 'done', '1'].includes(s)) return 'confirmed';
  if (['declined', 'rejected', 'cancelled', 'canceled', 'reversed', '2'].includes(s)) return 'reversed';
  return 'pending';
}

async function handle(req: Request, res: Response): Promise<void> {
  // impact-allow-no-oasis: this handler DOES record OASIS events (reward.<state>
  // and postback.unattributed) via a direct oasis_events insert below — the same
  // pattern as the local emitEvent() in vcaop.ts — just not via the emitOasisEvent
  // helper the scanner greps for.
  const supabase = getSupabase();
  if (!supabase) { res.status(503).json({ ok: false, error: 'database unavailable' }); return; }

  // Accept params from query (GET — Admitad default) or body (POST form/json).
  const p: Record<string, unknown> = { ...(req.query as any), ...(req.body as any) };
  if (!keyOk(String(p.key || ''))) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }

  const subId = String(p.subid || p.sub_id || '').trim();
  const orderId = String(p.order_id || p.order || '').trim();
  if (!subId || !orderId) { res.status(400).json({ ok: false, error: 'subid and order_id required' }); return; }

  const commission = Number(p.commission ?? p.revenue ?? 0) || 0;
  const currency = String(p.currency || 'EUR').toUpperCase().slice(0, 8);
  const state = mapStatus(String(p.status || ''));
  const now = new Date().toISOString();

  // Resolve the member from the subid (reverse attribution).
  const { data: map } = await supabase
    .from('subid_map')
    .select('user_id, tenant_id, affiliate_program_id, network')
    .eq('sub_id', subId)
    .maybeSingle();

  if (!map) {
    // Park unattributed postbacks (never error a retry storm); flag for reconciliation.
    await supabase.from('oasis_events').insert({
      id: randomUUID(), service: 'vcaop', source: 'vcaop',
      type: 'vcaop.postback.unattributed', topic: 'vcaop.postback.unattributed',
      status: 'warning', message: 'affiliate postback subid not found',
      metadata: { subId, orderId, state, commission }, created_at: now,
    }).then(() => {}, () => {});
    res.status(202).json({ ok: true, attributed: false });
    return;
  }

  const programId = String(map.affiliate_program_id || p.program || 'admitad');
  // Deterministic ids so network retries upsert the same rows (no double-credit).
  const fp = createHash('sha256').update(`admitad:${orderId}:${subId}`).digest('hex');
  const commissionId = 'cm_' + fp.slice(0, 24);
  const rewardId = 'rw_' + fp.slice(0, 24);
  const reward = +(commission * MEMBER_SHARE).toFixed(4);

  await supabase.from('commission_event').upsert({
    id: commissionId, affiliate_program_id: programId, sub_id: subId, user_id: map.user_id,
    merchant: String(p.merchant || map.network || 'admitad'), order_ref: orderId,
    gross_commission: +commission.toFixed(4), currency, status: state, postback_ref: orderId, updated_at: now,
  }, { onConflict: 'id' });

  await supabase.from('rewards_ledger').upsert({
    id: rewardId, user_id: map.user_id, commission_event_id: commissionId,
    amount: reward, currency, state, updated_at: now,
  }, { onConflict: 'id' });

  await supabase.from('oasis_events').insert({
    id: randomUUID(), service: 'vcaop', source: 'vcaop',
    type: `vcaop.reward.${state}`, topic: `vcaop.reward.${state}`,
    status: state === 'reversed' ? 'warning' : 'success', message: `admitad postback ${state}`,
    metadata: { commissionId, orderId, subId, userId: map.user_id, commission, reward, state }, created_at: now,
  }).then(() => {}, () => {});

  res.json({ ok: true, attributed: true, state, commissionId });
}

// Server-to-server affiliate postback (no user JWT); authenticated by the shared
// ADMITAD_POSTBACK_KEY (fail-closed in keyOk), not by user auth middleware.
router.get('/admitad', handle); // public-route
router.post( // public-route
  '/admitad',
  // impact-allow-no-oasis: handle() records reward.<state>/unattributed via a direct oasis_events insert
  handle,
);

export default router;
