import { pollChatMessagesOnce, startChatMessagesPolling } from '../../../src/services/realtime/chat-messages-poller';

/** Stub whose two tables (chat_group_members / chat_messages) can be scripted independently. */
function makeSupabaseStub(opts: { groupIds?: any; groupError?: any; messages?: any; messagesError?: any } = {}) {
  const groupResolved = { data: opts.groupIds ?? [], error: opts.groupError ?? null };
  const msgResolved = { data: opts.messages ?? [], error: opts.messagesError ?? null };

  const from = jest.fn((table: string) => {
    const chain: any = {};
    for (const m of ['select', 'eq', 'gt', 'or', 'order', 'limit']) chain[m] = () => chain;
    const resolved = table === 'chat_group_members' ? groupResolved : msgResolved;
    chain.then = (onResolve: (v: any) => void) => Promise.resolve(resolved).then(onResolve);
    return chain;
  });

  return { from };
}

describe('pollChatMessagesOnce', () => {
  const cursor = { sinceCreatedAt: '2026-01-01T00:00:00.000Z', sinceId: null };

  it('returns an unchanged cursor and empty rows when there is nothing new', async () => {
    const sb = makeSupabaseStub({ messages: [] });
    const result = await pollChatMessagesOnce(sb as any, 'tenant-1', 'user-1', cursor);
    expect(result.rows).toEqual([]);
    expect(result.cursor).toBe(cursor);
    expect(result.error).toBeNull();
  });

  it('advances the cursor to the last row on a successful poll', async () => {
    const rows = [
      { id: 'a', created_at: '2026-01-01T00:00:01.000Z' },
      { id: 'b', created_at: '2026-01-01T00:00:02.000Z' },
    ];
    const sb = makeSupabaseStub({ messages: rows });
    const result = await pollChatMessagesOnce(sb as any, 'tenant-1', 'user-1', cursor);
    expect(result.rows).toEqual(rows);
    expect(result.cursor).toEqual({ sinceCreatedAt: '2026-01-01T00:00:02.000Z', sinceId: 'b' });
  });

  it('short-circuits on a group-membership lookup failure without querying messages', async () => {
    const messagesQuery = jest.fn();
    const sb = { from: jest.fn((table: string) => {
      if (table === 'chat_group_members') {
        const chain: any = {};
        for (const m of ['select', 'eq']) chain[m] = () => chain;
        chain.then = (onResolve: (v: any) => void) => Promise.resolve({ data: null, error: { message: 'group lookup failed' } }).then(onResolve);
        return chain;
      }
      messagesQuery();
      const chain: any = {};
      for (const m of ['select', 'eq', 'gt', 'or', 'order', 'limit']) chain[m] = () => chain;
      chain.then = (onResolve: (v: any) => void) => Promise.resolve({ data: [], error: null }).then(onResolve);
      return chain;
    }) };

    const result = await pollChatMessagesOnce(sb as any, 'tenant-1', 'user-1', cursor);
    expect(result.error).toEqual({ message: 'group lookup failed' });
    expect(result.cursor).toBe(cursor);
    expect(messagesQuery).not.toHaveBeenCalled();
  });

  it('leaves the cursor unchanged and reports the error on a message-query failure', async () => {
    const sb = makeSupabaseStub({ messagesError: { message: 'boom' } });
    const result = await pollChatMessagesOnce(sb as any, 'tenant-1', 'user-1', cursor);
    expect(result.rows).toEqual([]);
    expect(result.cursor).toBe(cursor);
    expect(result.error).toEqual({ message: 'boom' });
  });
});

describe('startChatMessagesPolling', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('invokes onRows once per non-empty poll, on the configured interval', async () => {
    const rows1 = [{ id: 'a', created_at: '2026-01-01T00:00:01.000Z' }];
    let call = 0;
    const responses = [rows1, [], [{ id: 'b', created_at: '2026-01-01T00:00:02.000Z' }]];
    const sb = { from: jest.fn((table: string) => {
      const chain: any = {};
      for (const m of ['select', 'eq', 'gt', 'or', 'order', 'limit']) chain[m] = () => chain;
      if (table === 'chat_group_members') {
        chain.then = (onResolve: (v: any) => void) => Promise.resolve({ data: [], error: null }).then(onResolve);
        return chain;
      }
      const resp = responses[Math.min(call, responses.length - 1)];
      call++;
      chain.then = (onResolve: (v: any) => void) => Promise.resolve({ data: resp, error: null }).then(onResolve);
      return chain;
    }) };

    const onRows = jest.fn();
    const stop = startChatMessagesPolling(
      sb as any,
      'tenant-1',
      'user-1',
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

  it('stops polling once the returned stop function is called', async () => {
    const sb = makeSupabaseStub({ messages: [] });
    const stop = startChatMessagesPolling(
      sb as any,
      'tenant-1',
      'user-1',
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
