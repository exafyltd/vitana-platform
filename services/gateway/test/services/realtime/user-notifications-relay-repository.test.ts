import { fetchNotificationsSinceCursor } from '../../../src/services/realtime/user-notifications-relay-repository';

/** Same functional stub pattern used across this repo's other B1/B-workstream repository tests. */
function makeSupabaseStub(response: { data?: any; error?: any } = {}) {
  const calls: { method: string; args: any[] }[] = [];
  const resolved = { data: response.data ?? null, error: response.error ?? null };

  const chain: any = {};
  const record = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    return chain;
  };
  for (const m of ['select', 'eq', 'gt', 'or', 'order', 'limit']) {
    chain[m] = record(m);
  }
  chain.then = (onResolve: (v: any) => void) => Promise.resolve(resolved).then(onResolve);

  const from = jest.fn((table: string) => {
    calls.push({ method: 'from', args: [table] });
    return chain;
  });

  return { from, calls };
}

describe('fetchNotificationsSinceCursor', () => {
  it('scopes to user_id, tenant_id, and queries the user_notifications table', async () => {
    const sb = makeSupabaseStub({ data: [] });
    await fetchNotificationsSinceCursor(
      sb as any,
      'user-1',
      'tenant-1',
      { sinceCreatedAt: '2026-01-01T00:00:00.000Z', sinceId: null },
      50,
    );

    expect(sb.from).toHaveBeenCalledWith('user_notifications');
    const eqCalls = sb.calls.filter((c) => c.method === 'eq');
    expect(eqCalls).toContainEqual({ method: 'eq', args: ['user_id', 'user-1'] });
    expect(eqCalls).toContainEqual({ method: 'eq', args: ['tenant_id', 'tenant-1'] });
  });

  it('uses a plain gt(created_at) filter when the cursor has no tie-breaker id', async () => {
    const sb = makeSupabaseStub({ data: [] });
    await fetchNotificationsSinceCursor(
      sb as any,
      'user-1',
      null,
      { sinceCreatedAt: '2026-01-01T00:00:00.000Z', sinceId: null },
      50,
    );

    const gtCalls = sb.calls.filter((c) => c.method === 'gt');
    expect(gtCalls).toContainEqual({ method: 'gt', args: ['created_at', '2026-01-01T00:00:00.000Z'] });
    expect(sb.calls.some((c) => c.method === 'or')).toBe(false);
  });

  it('uses an or() tie-break filter when the cursor carries a sinceId', async () => {
    const sb = makeSupabaseStub({ data: [] });
    await fetchNotificationsSinceCursor(
      sb as any,
      'user-1',
      null,
      { sinceCreatedAt: '2026-01-01T00:00:00.000Z', sinceId: 'row-5' },
      50,
    );

    const orCall = sb.calls.find((c) => c.method === 'or');
    expect(orCall).toBeDefined();
    expect(orCall!.args[0]).toContain('created_at.gt.2026-01-01T00:00:00.000Z');
    expect(orCall!.args[0]).toContain('id.gt.row-5');
    expect(sb.calls.some((c) => c.method === 'gt')).toBe(false);
  });

  it('orders ascending by created_at then id, and applies the limit', async () => {
    const sb = makeSupabaseStub({ data: [] });
    await fetchNotificationsSinceCursor(
      sb as any,
      'user-1',
      null,
      { sinceCreatedAt: '2026-01-01T00:00:00.000Z', sinceId: null },
      25,
    );

    const orderCalls = sb.calls.filter((c) => c.method === 'order');
    expect(orderCalls).toEqual([
      { method: 'order', args: ['created_at', { ascending: true }] },
      { method: 'order', args: ['id', { ascending: true }] },
    ]);
    expect(sb.calls).toContainEqual({ method: 'limit', args: [25] });
  });
});
