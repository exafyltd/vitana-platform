// VTID-05718 — push-dispatch skips held and claimed chat rows, and keeps rows whose push_outcome is NULL.
// The filter is NULL-safe: a plain neq/NOT would drop every row with push_outcome NULL.
import { fetchPendingPushNotifications } from '../src/routes/scheduled-notifications-repository';

describe('fetchPendingPushNotifications (VTID-05718)', () => {
  test('applies the NULL-safe push_outcome filter', () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const chain: any = {};
    for (const m of ['select', 'is', 'in', 'gte', 'order', 'limit', 'or']) {
      chain[m] = (...a: unknown[]) => {
        calls.push([m, ...a]);
        return chain;
      };
    }
    const sb: any = { from: (table: string) => { calls.push(['from', table]); return chain; } };

    fetchPendingPushNotifications(sb, '2026-11-01T00:00:00.000Z');

    expect(calls).toEqual(expect.arrayContaining([
      ['from', 'user_notifications'],
      ['is', 'push_sent_at', null],
      ['or', 'push_outcome.is.null,push_outcome.not.in.(pending_burst,sending)'],
    ]));
  });
});
