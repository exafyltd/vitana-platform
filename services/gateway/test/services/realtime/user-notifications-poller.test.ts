import { pollNotificationsOnce, startNotificationPolling } from '../../../src/services/realtime/user-notifications-poller';

function makeSupabaseStub(response: { data?: any; error?: any } = {}) {
  const resolved = { data: response.data ?? null, error: response.error ?? null };
  const chain: any = {};
  const record = () => () => chain;
  for (const m of ['select', 'eq', 'gt', 'or', 'order', 'limit']) {
    chain[m] = record();
  }
  chain.then = (onResolve: (v: any) => void) => Promise.resolve(resolved).then(onResolve);
  const from = jest.fn(() => chain);
  return { from };
}

describe('pollNotificationsOnce', () => {
  const cursor = { sinceCreatedAt: '2026-01-01T00:00:00.000Z', sinceId: null };

  it('returns an unchanged cursor and empty rows when there is nothing new', async () => {
    const sb = makeSupabaseStub({ data: [] });
    const result = await pollNotificationsOnce(sb as any, 'u1', 't1', cursor);
    expect(result.rows).toEqual([]);
    expect(result.cursor).toBe(cursor);
    expect(result.error).toBeNull();
  });

  it('advances the cursor to the last row on a successful poll', async () => {
    const rows = [
      { id: 'a', created_at: '2026-01-01T00:00:01.000Z' },
      { id: 'b', created_at: '2026-01-01T00:00:02.000Z' },
    ];
    const sb = makeSupabaseStub({ data: rows });
    const result = await pollNotificationsOnce(sb as any, 'u1', 't1', cursor);
    expect(result.rows).toEqual(rows);
    expect(result.cursor).toEqual({ sinceCreatedAt: '2026-01-01T00:00:02.000Z', sinceId: 'b' });
    expect(result.error).toBeNull();
  });

  it('leaves the cursor unchanged and reports the error on a query failure, so the same window is retried', async () => {
    const sb = makeSupabaseStub({ error: { message: 'boom' } });
    const result = await pollNotificationsOnce(sb as any, 'u1', 't1', cursor);
    expect(result.rows).toEqual([]);
    expect(result.cursor).toBe(cursor);
    expect(result.error).toEqual({ message: 'boom' });
  });
});

describe('startNotificationPolling', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('invokes onRows once per non-empty poll, on the configured interval', async () => {
    const rows1 = [{ id: 'a', created_at: '2026-01-01T00:00:01.000Z' }];
    let call = 0;
    const responses = [{ data: rows1 }, { data: [] }, { data: [{ id: 'b', created_at: '2026-01-01T00:00:02.000Z' }] }];
    const sb = { from: jest.fn(() => {
      const resp = responses[Math.min(call, responses.length - 1)];
      call++;
      const chain: any = {};
      for (const m of ['select', 'eq', 'gt', 'or', 'order', 'limit']) chain[m] = () => chain;
      chain.then = (onResolve: (v: any) => void) => Promise.resolve({ data: resp.data, error: null }).then(onResolve);
      return chain;
    }) };

    const onRows = jest.fn();
    const stop = startNotificationPolling(
      sb as any,
      'u1',
      't1',
      { sinceCreatedAt: '2026-01-01T00:00:00.000Z', sinceId: null },
      onRows,
      { intervalMs: 1000 },
    );

    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);

    expect(onRows).toHaveBeenCalledTimes(2);
    expect(onRows).toHaveBeenNthCalledWith(1, rows1);
    stop();
  });

  it('calls onError on a query failure without stopping subsequent polls', async () => {
    let call = 0;
    const sb = { from: jest.fn(() => {
      call++;
      const chain: any = {};
      for (const m of ['select', 'eq', 'gt', 'or', 'order', 'limit']) chain[m] = () => chain;
      const resp = call === 1 ? { data: null, error: { message: 'transient' } } : { data: [], error: null };
      chain.then = (onResolve: (v: any) => void) => Promise.resolve(resp).then(onResolve);
      return chain;
    }) };

    const onError = jest.fn();
    const onRows = jest.fn();
    const stop = startNotificationPolling(
      sb as any,
      'u1',
      't1',
      { sinceCreatedAt: '2026-01-01T00:00:00.000Z', sinceId: null },
      onRows,
      { intervalMs: 1000, onError },
    );

    await jest.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledWith('transient');

    await jest.advanceTimersByTimeAsync(1000);
    expect(call).toBeGreaterThanOrEqual(2);
    stop();
  });

  it('stops polling once the returned stop function is called', async () => {
    const sb = { from: jest.fn(() => {
      const chain: any = {};
      for (const m of ['select', 'eq', 'gt', 'or', 'order', 'limit']) chain[m] = () => chain;
      chain.then = (onResolve: (v: any) => void) => Promise.resolve({ data: [], error: null }).then(onResolve);
      return chain;
    }) };

    const onRows = jest.fn();
    const stop = startNotificationPolling(
      sb as any,
      'u1',
      't1',
      { sinceCreatedAt: '2026-01-01T00:00:00.000Z', sinceId: null },
      onRows,
      { intervalMs: 1000 },
    );

    await jest.advanceTimersByTimeAsync(1000);
    const callsAfterOneTick = sb.from.mock.calls.length;
    expect(callsAfterOneTick).toBeGreaterThan(0);

    stop();
    await jest.advanceTimersByTimeAsync(5000);
    expect(sb.from.mock.calls.length).toBe(callsAfterOneTick);
  });
});
