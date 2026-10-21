import { fetchChatMessagesSinceCursor, fetchUserGroupIds } from '../../../src/services/realtime/chat-messages-relay-repository';

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

describe('fetchUserGroupIds', () => {
  it('queries chat_group_members scoped to the user and returns the group_id list', async () => {
    const sb = makeSupabaseStub({ data: [{ group_id: 'g1' }, { group_id: 'g2' }] });
    const result = await fetchUserGroupIds(sb as any, 'user-1');

    expect(sb.from).toHaveBeenCalledWith('chat_group_members');
    expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'user-1'] });
    expect(result).toEqual({ groupIds: ['g1', 'g2'], error: null });
  });

  it('returns an empty list and the error on a query failure', async () => {
    const sb = makeSupabaseStub({ error: { message: 'boom' } });
    const result = await fetchUserGroupIds(sb as any, 'user-1');
    expect(result).toEqual({ groupIds: [], error: { message: 'boom' } });
  });
});

describe('fetchChatMessagesSinceCursor', () => {
  const cursor = { sinceCreatedAt: '2026-01-01T00:00:00.000Z', sinceId: null };

  it('scopes to tenant_id and queries chat_messages', async () => {
    const sb = makeSupabaseStub({ data: [] });
    await fetchChatMessagesSinceCursor(sb as any, 'tenant-1', 'user-1', [], cursor, 50);

    expect(sb.from).toHaveBeenCalledWith('chat_messages');
    expect(sb.calls).toContainEqual({ method: 'eq', args: ['tenant_id', 'tenant-1'] });
  });

  it('the visibility clause includes sender_id and receiver_id even with no groups', async () => {
    const sb = makeSupabaseStub({ data: [] });
    await fetchChatMessagesSinceCursor(sb as any, 'tenant-1', 'user-1', [], cursor, 50);

    const visibilityOr = sb.calls.find((c) => c.method === 'or' && c.args[0].includes('sender_id'));
    expect(visibilityOr!.args[0]).toBe('sender_id.eq.user-1,receiver_id.eq.user-1');
  });

  it('adds a group_id.in(...) clause to the visibility filter when the caller belongs to groups', async () => {
    const sb = makeSupabaseStub({ data: [] });
    await fetchChatMessagesSinceCursor(sb as any, 'tenant-1', 'user-1', ['g1', 'g2'], cursor, 50);

    const visibilityOr = sb.calls.find((c) => c.method === 'or' && c.args[0].includes('sender_id'));
    expect(visibilityOr!.args[0]).toBe('sender_id.eq.user-1,receiver_id.eq.user-1,group_id.in.(g1,g2)');
  });

  it('applies a separate or() cursor tie-break filter, ANDed with the visibility filter', async () => {
    const sb = makeSupabaseStub({ data: [] });
    await fetchChatMessagesSinceCursor(sb as any, 'tenant-1', 'user-1', [], { ...cursor, sinceId: 'row-5' }, 50);

    const orCalls = sb.calls.filter((c) => c.method === 'or');
    expect(orCalls).toHaveLength(2);
    expect(orCalls[1].args[0]).toContain('id.gt.row-5');
  });

  it('orders ascending by created_at then id, and applies the limit', async () => {
    const sb = makeSupabaseStub({ data: [] });
    await fetchChatMessagesSinceCursor(sb as any, 'tenant-1', 'user-1', [], cursor, 25);
    expect(sb.calls).toEqual(
      expect.arrayContaining([
        { method: 'order', args: ['created_at', { ascending: true }] },
        { method: 'order', args: ['id', { ascending: true }] },
        { method: 'limit', args: [25] },
      ]),
    );
  });
});
