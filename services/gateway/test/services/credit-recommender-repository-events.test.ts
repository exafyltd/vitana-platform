/**
 * The commission OASIS events are written straight to oasis_events. That table
 * has no `type` column and requires `role`, so the row callers build (with
 * `type`, without `role`) was rejected by PostgREST and, with the error
 * swallowed, never written: no `marketplace.recommendation.*` event exists in
 * the table. The helper now drops `type` and sets `role`.
 */
import { insertCommissionSkippedIneligibleEvent } from '../../src/services/recommendation-commissions/credit-recommender-repository';

describe('insertCommissionSkippedIneligibleEvent', () => {
  it('writes a row oasis_events accepts: no `type`, a `role`, everything else unchanged', async () => {
    const insert = jest.fn().mockResolvedValue({ error: null });
    const from = jest.fn().mockReturnValue({ insert });
    const sb = { from } as any;
    const row = {
      service: 'discover', source: 'recommendation-commissions',
      type: 'marketplace.recommendation.commission_skipped_invalid_referral',
      topic: 'marketplace.recommendation.commission_skipped_invalid_referral',
      status: 'info', message: 'referral does not count: self_referral',
      metadata: { orderId: 'order-1' }, created_at: '2026-09-29T00:00:00.000Z',
    };

    await insertCommissionSkippedIneligibleEvent(sb, row);

    expect(from).toHaveBeenCalledWith('oasis_events');
    const written = insert.mock.calls[0][0];
    expect(written).not.toHaveProperty('type');
    expect(written).toEqual({
      role: 'GATEWAY',
      service: 'discover', source: 'recommendation-commissions',
      topic: 'marketplace.recommendation.commission_skipped_invalid_referral',
      status: 'info', message: 'referral does not count: self_referral',
      metadata: { orderId: 'order-1' }, created_at: '2026-09-29T00:00:00.000Z',
    });
    expect(row).toHaveProperty('type'); // the caller's object is not mutated
  });
});
