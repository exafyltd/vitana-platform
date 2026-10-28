import { fetchRowsSinceCursor, pollRowsOnce, startRowPolling } from '../../../src/services/realtime/generic-cursor-relay';

function makeSupabaseStub(response: { data?: any; error?: any } = {}) {
  const calls: { method: string; args: any[] }[] = [];
  const resolved = { data: response.data ?? null, error: response.error ?? null };

  const chain: any = {};
  const record = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    return chain;
  };
  for (const m of ['select', 'eq', 'is', 'gt', 'or', 'order', 'limit']) {
    chain[m] = record(m);
  }
  chain.then = (onResolve: (v: any) => void) => Promise.resolve(resolved).then(onResolve);

  const from = jest.fn((table: string) => {
    calls.push({ method: 'from', args: [table] });
    return chain;
  });

  return { from, calls };
}

describe('fetchRowsSinceCursor', () => {
  const cursor = { sinceCreatedAt: '2026-01-01T00:00:00.000Z', sinceId: null };

  it('queries the configured table and applies an eq() filter per non-null config.filters entry', async () => {
    const sb = makeSupabaseStub({ data: [] });
    await fetchRowsSinceCursor(sb as any, { table: 'user_activity_log', filters: { user_id: 'u1' } }, cursor, 50);

    expect(sb.from).toHaveBeenCalledWith('user_activity_log');
    expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
  });

  it('applies both filters for a two-column ownership model (user_notifications shape)', async () => {
    const sb = makeSupabaseStub({ data: [] });
    await fetchRowsSinceCursor(
      sb as any,
      { table: 'user_notifications', filters: { user_id: 'u1', tenant_id: 't1' } },
      cursor,
      50,
    );

    expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
    expect(sb.calls).toContainEqual({ method: 'eq', args: ['tenant_id', 't1'] });
  });

  it('uses is(column, null) instead of eq() when a filter value is null', async () => {
    const sb = makeSupabaseStub({ data: [] });
    await fetchRowsSinceCursor(sb as any, { table: 'user_notifications', filters: { tenant_id: null } }, cursor, 50);

    expect(sb.calls).toContainEqual({ method: 'is', args: ['tenant_id', null] });
    expect(sb.calls.some((c) => c.method === 'eq')).toBe(false);
  });

  it('uses a plain gt(created_at) filter when the cursor has no tie-breaker id, or() when it does', async () => {
    const sb1 = makeSupabaseStub({ data: [] });
    await fetchRowsSinceCursor(sb1 as any, { table: 't', filters: {} }, cursor, 50);
    expect(sb1.calls).toContainEqual({ method: 'gt', args: ['created_at', cursor.sinceCreatedAt] });

    const sb2 = makeSupabaseStub({ data: [] });
    await fetchRowsSinceCursor(sb2 as any, { table: 't', filters: {} }, { ...cursor, sinceId: 'row-5' }, 50);
    const orCall = sb2.calls.find((c) => c.method === 'or');
    expect(orCall!.args[0]).toContain('id.gt.row-5');
    expect(sb2.calls.some((c) => c.method === 'gt')).toBe(false);
  });

  it('selects the configured column list, or * when omitted', async () => {
    const sb1 = makeSupabaseStub({ data: [] });
    await fetchRowsSinceCursor(sb1 as any, { table: 't', filters: {} }, cursor, 50);
    expect(sb1.calls).toContainEqual({ method: 'select', args: ['*'] });

    const sb2 = makeSupabaseStub({ data: [] });
    await fetchRowsSinceCursor(sb2 as any, { table: 't', filters: {}, columns: 'id, activity_type' }, cursor, 50);
    expect(sb2.calls).toContainEqual({ method: 'select', args: ['id, activity_type'] });
  });

  it('orders ascending by created_at then id, and applies the limit', async () => {
    const sb = makeSupabaseStub({ data: [] });
    await fetchRowsSinceCursor(sb as any, { table: 't', filters: {} }, cursor, 25);
    expect(sb.calls).toEqual(
      expect.arrayContaining([
        { method: 'order', args: ['created_at', { ascending: true }] },
        { method: 'order', args: ['id', { ascending: true }] },
        { method: 'limit', args: [25] },
      ]),
    );
  });
});

describe('pollRowsOnce', () => {
  const config = { table: 'user_activity_log', filters: { user_id: 'u1' } };
  const cursor = { sinceCreatedAt: '2026-01-01T00:00:00.000Z', sinceId: null };

  it('returns an unchanged cursor and empty rows when there is nothing new', async () => {
    const sb = makeSupabaseStub({ data: [] });
    const result = await pollRowsOnce(sb as any, config, cursor);
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
    const result = await pollRowsOnce(sb as any, config, cursor);
    expect(result.rows).toEqual(rows);
    expect(result.cursor).toEqual({ sinceCreatedAt: '2026-01-01T00:00:02.000Z', sinceId: 'b' });
  });

  it('leaves the cursor unchanged and reports the error on a query failure, so the same window is retried', async () => {
    const sb = makeSupabaseStub({ error: { message: 'boom' } });
    const result = await pollRowsOnce(sb as any, config, cursor);
    expect(result.rows).toEqual([]);
    expect(result.cursor).toBe(cursor);
    expect(result.error).toEqual({ message: 'boom' });
  });
});

describe('startRowPolling', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const config = { table: 'user_activity_log', filters: { user_id: 'u1' } };

  it('invokes onRows once per non-empty poll, on the configured interval', async () => {
    const rows1 = [{ id: 'a', created_at: '2026-01-01T00:00:01.000Z' }];
    let call = 0;
    const responses = [{ data: rows1 }, { data: [] }, { data: [{ id: 'b', created_at: '2026-01-01T00:00:02.000Z' }] }];
    const sb = {
      from: jest.fn(() => {
        const resp = responses[Math.min(call, responses.length - 1)];
        call++;
        const chain: any = {};
        for (const m of ['select', 'eq', 'is', 'gt', 'or', 'order', 'limit']) chain[m] = () => chain;
        chain.then = (onResolve: (v: any) => void) => Promise.resolve({ data: resp.data, error: null }).then(onResolve);
        return chain;
      }),
    };

    const onRows = jest.fn();
    const stop = startRowPolling(
      sb as any,
      config,
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
    const sb = {
      from: jest.fn(() => {
        call++;
        const chain: any = {};
        for (const m of ['select', 'eq', 'is', 'gt', 'or', 'order', 'limit']) chain[m] = () => chain;
        const resp = call === 1 ? { data: null, error: { message: 'transient' } } : { data: [], error: null };
        chain.then = (onResolve: (v: any) => void) => Promise.resolve(resp).then(onResolve);
        return chain;
      }),
    };

    const onError = jest.fn();
    const stop = startRowPolling(
      sb as any,
      config,
      { sinceCreatedAt: '2026-01-01T00:00:00.000Z', sinceId: null },
      jest.fn(),
      { intervalMs: 1000, onError },
    );

    await jest.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledWith('transient');
    await jest.advanceTimersByTimeAsync(1000);
    expect(call).toBeGreaterThanOrEqual(2);
    stop();
  });

  it('stops polling once the returned stop function is called', async () => {
    const sb = {
      from: jest.fn(() => {
        const chain: any = {};
        for (const m of ['select', 'eq', 'is', 'gt', 'or', 'order', 'limit']) chain[m] = () => chain;
        chain.then = (onResolve: (v: any) => void) => Promise.resolve({ data: [], error: null }).then(onResolve);
        return chain;
      }),
    };

    const stop = startRowPolling(
      sb as any,
      config,
      { sinceCreatedAt: '2026-01-01T00:00:00.000Z', sinceId: null },
      jest.fn(),
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
