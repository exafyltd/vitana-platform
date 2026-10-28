/**
 * VTID-04421 (Plan v1 WS-2.4) — conversation_offer_outcomes: one row per
 * suggestion, settled by its first outcome, read per provider.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  applyOfferOutcomeWrite,
  buildOfferOutcomeWrite,
  type PendingOffer,
} from '../../../src/services/assistant-continuation/offer-outcomes';
import {
  readOfferOutcomeStats,
  toOfferOutcomeStatRow,
} from '../../../src/services/conversation/offer-outcome-stats';

const NOW = '2026-09-23T18:00:00.000Z';
const offer: PendingOffer = {
  tool: 'navigate_to_screen',
  payload: { screen: 'diary' },
  offered_at: '2026-09-23T17:59:00.000Z',
  offer_id: '11111111-2222-4333-8444-555555555555',
  source: 'wake_brief',
  provider: 'journey_guide',
  key: 'journey_guide:diary',
};

describe('buildOfferOutcomeWrite', () => {
  it('made inserts one row carrying provider, key and tool', () => {
    expect(buildOfferOutcomeWrite('made', 'u-1', offer, {}, NOW)).toEqual({
      op: 'insert',
      row: {
        offer_id: offer.offer_id,
        user_id: 'u-1',
        source: 'wake_brief',
        provider: 'journey_guide',
        offer_key: 'journey_guide:diary',
        tool: 'navigate_to_screen',
        offered_at: '2026-09-23T17:59:00.000Z',
        outcome: 'made',
      },
    });
  });

  it('accepted / declined / ignored settle the row with the reason', () => {
    for (const o of ['accepted', 'declined', 'ignored'] as const) {
      expect(buildOfferOutcomeWrite(o, 'u-1', offer, { reason: 'replaced' }, NOW)).toEqual({
        op: 'settle',
        offer_id: offer.offer_id,
        patch: { outcome: o, outcome_at: NOW, outcome_reason: 'replaced', updated_at: NOW },
      });
    }
  });

  it('a legacy offer without an id, or no user, is not tracked', () => {
    expect(buildOfferOutcomeWrite('made', 'u-1', { ...offer, offer_id: undefined })).toBeNull();
    expect(buildOfferOutcomeWrite('accepted', '', offer)).toBeNull();
  });

  it('the provider falls back to the source', () => {
    const w = buildOfferOutcomeWrite('made', 'u-1', { ...offer, provider: null }, {}, NOW);
    expect(w && w.op === 'insert' ? w.row.provider : null).toBe('wake_brief');
  });
});

function fakeSb(result: { error: unknown } = { error: null }) {
  const calls: Array<[string, unknown[]]> = [];
  const b: any = {};
  for (const m of ['from', 'upsert', 'update', 'eq']) {
    b[m] = (...args: unknown[]) => { calls.push([m, args]); return b; };
  }
  b.then = (res: any, rej: any) => Promise.resolve(result).then(res, rej);
  return { sb: b, calls };
}

describe('applyOfferOutcomeWrite', () => {
  it('inserts idempotently on offer_id', async () => {
    const { sb, calls } = fakeSb();
    const r = await applyOfferOutcomeWrite(sb, buildOfferOutcomeWrite('made', 'u-1', offer, {}, NOW)!);
    expect(r.ok).toBe(true);
    expect(calls[0]).toEqual(['from', ['conversation_offer_outcomes']]);
    expect(calls[1][0]).toBe('upsert');
    expect(calls[1][1][1]).toEqual({ onConflict: 'offer_id', ignoreDuplicates: true });
  });

  it('settles only a row still at made (the first outcome wins)', async () => {
    const { sb, calls } = fakeSb();
    await applyOfferOutcomeWrite(sb, buildOfferOutcomeWrite('declined', 'u-1', offer, {}, NOW)!);
    expect(calls).toContainEqual(['eq', ['offer_id', offer.offer_id]]);
    expect(calls).toContainEqual(['eq', ['outcome', 'made']]);
  });

  it('reports a storage error instead of throwing', async () => {
    const { sb } = fakeSb({ error: { message: 'rls' } });
    await expect(applyOfferOutcomeWrite(sb, buildOfferOutcomeWrite('made', 'u-1', offer, {}, NOW)!)).resolves.toEqual({ ok: false, reason: 'rls' });
  });
});

describe('offer outcome stats', () => {
  it('computes the acceptance rate over settled offers only', () => {
    expect(toOfferOutcomeStatRow({ provider: 'journey_guide', made: '10', accepted: '3', declined: '1', ignored: '2', open: '4' })).toEqual({
      provider: 'journey_guide', made: 10, accepted: 3, declined: 1, ignored: 2, open: 4, acceptance_rate: 0.5,
    });
    expect(toOfferOutcomeStatRow({ provider: 'x', made: 2, accepted: 0, declined: 0, ignored: 0, open: 2 }).acceptance_rate).toBeNull();
  });

  it('reads through the service-role function with a bounded window', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: [{ provider: 'p', made: 1, accepted: 1, declined: 0, ignored: 0, open: 0 }], error: null });
    const r = await readOfferOutcomeStats({ rpc } as any, { days: 500, userId: 'a27552a3-0257-4305-8ed0-351a80fd3701', nowMs: Date.parse(NOW) });
    expect(r.rows[0].acceptance_rate).toBe(1);
    const [fn, args] = rpc.mock.calls[0];
    expect(fn).toBe('conversation_offer_outcome_stats');
    expect(Date.parse(NOW) - Date.parse(args.p_since)).toBe(90 * 86_400_000);
    expect(args.p_user_id).toBe('a27552a3-0257-4305-8ed0-351a80fd3701');
  });
});

describe('source contracts', () => {
  const root = join(__dirname, '../../../../..');
  const migration = readFileSync(join(root, 'supabase/migrations/20260923190000_vtid_04421_conversation_offer_outcomes.sql'), 'utf8');
  const hub = readFileSync(join(root, 'services/gateway/src/routes/conversation-hub.ts'), 'utf8');
  const app = readFileSync(join(root, 'services/gateway/src/frontend/command-hub/app.js'), 'utf8');
  const offers = readFileSync(join(root, 'services/gateway/src/services/assistant-continuation/offer-outcomes.ts'), 'utf8');

  it('the table is service-role only', () => {
    expect(migration).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/REVOKE ALL ON public\.conversation_offer_outcomes FROM anon, authenticated/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.conversation_offer_outcome_stats\(timestamptz, interval, uuid\) TO service_role/);
  });

  it('the default emitter writes the row alongside the OASIS event', () => {
    expect(offers).toMatch(/export const defaultEmitOfferEvent[\s\S]{0,200}writeOfferOutcomeRow\(outcome, userId, offer, detail\)/);
  });

  it('the read endpoint is admin-only and validates user_id', () => {
    expect(hub).toMatch(/router\.get\('\/admin\/conversation\/offer-outcomes', \.\.\.adminOnly,/);
    expect(hub).toMatch(/offer-outcomes[\s\S]{0,400}isValidUserId\(userId\)/);
  });

  it('the Monitor tab shows the suggestion outcomes', () => {
    expect(app).toMatch(/_convRenderOfferOutcomes\(offers, 7\);/);
    expect(app).toMatch(/'\/admin\/conversation\/offer-outcomes\?days=' \+ days/);
  });
});
