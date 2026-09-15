import * as repo from '../../src/routes/chat-groups-repository';

/**
 * Functional stub Supabase client — a from()-chain that records every
 * call and resolves to a configurable {data,error,count} response,
 * matching the pattern used for other B1 repository tests.
 */
function makeSupabaseStub(response: { data?: any; error?: any; count?: number | null } = {}) {
  const calls: { method: string; args: any[] }[] = [];
  const resolved = { data: response.data ?? null, error: response.error ?? null, count: response.count ?? null };

  const chain: any = {};
  const record = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    return chain;
  };
  for (const m of ['select', 'eq', 'neq', 'gt', 'lt', 'in', 'order', 'limit', 'filter', 'update', 'insert', 'delete']) {
    chain[m] = record(m);
  }
  chain.single = jest.fn(() => Promise.resolve(resolved));
  chain.maybeSingle = jest.fn(() => Promise.resolve(resolved));
  chain.then = (onResolve: (v: any) => void) => Promise.resolve(resolved).then(onResolve);

  const from = jest.fn((table: string) => {
    calls.push({ method: 'from', args: [table] });
    return chain;
  });

  return { from, calls, chain };
}

describe('chat-groups-repository', () => {
  describe('listChatGroupMemberships', () => {
    it('scopes to user_id + tenant_id', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.listChatGroupMemberships(sb as any, 'u1', 't1');
      expect(sb.from).toHaveBeenCalledWith('chat_group_members');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['tenant_id', 't1'] });
    });
  });

  describe('listChatGroupsByIds', () => {
    it('selects by id .in()', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.listChatGroupsByIds(sb as any, ['g1', 'g2']);
      expect(sb.from).toHaveBeenCalledWith('chat_groups');
      expect(sb.calls).toContainEqual({ method: 'in', args: ['id', ['g1', 'g2']] });
    });
  });

  describe('listLatestChatMessagesForGroups', () => {
    it('orders desc and limits to 500', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.listLatestChatMessagesForGroups(sb as any, ['g1']);
      expect(sb.calls).toContainEqual({ method: 'order', args: ['created_at', { ascending: false }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [500] });
    });
  });

  describe('countUnreadChatMessagesForGroup', () => {
    it('applies since filter only when provided', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countUnreadChatMessagesForGroup(sb as any, { groupId: 'g1', userId: 'u1' });
      expect(sb.calls.some((c) => c.method === 'gt')).toBe(false);

      const sb2 = makeSupabaseStub({ count: 3 });
      await repo.countUnreadChatMessagesForGroup(sb2 as any, { groupId: 'g1', userId: 'u1', since: '2026-01-01' });
      expect(sb2.calls).toContainEqual({ method: 'gt', args: ['created_at', '2026-01-01'] });
    });

    it('always excludes the caller as sender', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countUnreadChatMessagesForGroup(sb as any, { groupId: 'g1', userId: 'u1' });
      expect(sb.calls).toContainEqual({ method: 'neq', args: ['sender_id', 'u1'] });
    });
  });

  describe('fetchChatGroupWithMembers', () => {
    it('queries chat_groups and chat_group_members in parallel', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchChatGroupWithMembers(sb as any, 'g1');
      const tables = sb.calls.filter((c) => c.method === 'from').map((c) => c.args[0]);
      expect(tables).toEqual(['chat_groups', 'chat_group_members']);
    });
  });

  describe('listChatGroupMessages', () => {
    it('applies the before cursor only when provided', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.listChatGroupMessages(sb as any, { groupId: 'g1', limit: 50 });
      expect(sb.calls.some((c) => c.method === 'lt')).toBe(false);

      const sb2 = makeSupabaseStub({ data: [] });
      await repo.listChatGroupMessages(sb2 as any, { groupId: 'g1', limit: 50, before: '2026-01-01' });
      expect(sb2.calls).toContainEqual({ method: 'lt', args: ['created_at', '2026-01-01'] });
    });
  });

  describe('insertChatGroupMessage vs insertChatGroupMessageNoReturn', () => {
    it('insertChatGroupMessage reads the inserted row back via select().single()', async () => {
      const sb = makeSupabaseStub({ data: { id: 'm1' } });
      await repo.insertChatGroupMessage(sb as any, { content: 'hi' });
      expect(sb.calls).toContainEqual({ method: 'select', args: [] });
      expect(sb.chain.single).toHaveBeenCalled();
    });

    it('insertChatGroupMessageNoReturn does NOT call select()/single() - matches the @vitana-reply insert, which never reads the row back', async () => {
      const sb = makeSupabaseStub();
      await repo.insertChatGroupMessageNoReturn(sb as any, { content: 'reply' });
      expect(sb.calls.some((c) => c.method === 'select')).toBe(false);
      expect(sb.chain.single).not.toHaveBeenCalled();
    });
  });

  describe('updateChatGroupMessageContent / deleteChatGroupMessage', () => {
    it('update scopes by id and returns single()', async () => {
      const sb = makeSupabaseStub({ data: { id: 'm1' } });
      await repo.updateChatGroupMessageContent(sb as any, 'm1', 'edited');
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ content: 'edited' }] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'm1'] });
    });

    it('delete scopes by id only (no group/user filter — caller already verified ownership)', async () => {
      const sb = makeSupabaseStub();
      await repo.deleteChatGroupMessage(sb as any, 'm1');
      expect(sb.calls).toContainEqual({ method: 'delete', args: [] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'm1'] });
    });
  });

  describe('markChatGroupRead', () => {
    it('scopes update by group_id + user_id', async () => {
      const sb = makeSupabaseStub();
      await repo.markChatGroupRead(sb as any, 'g1', 'u1');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['group_id', 'g1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
    });
  });

  describe('ownership / membership guards', () => {
    it('fetchChatMessageOwnership selects sender_id + group_id by id', async () => {
      const sb = makeSupabaseStub({ data: { sender_id: 'u1', group_id: 'g1' } });
      await repo.fetchChatMessageOwnership(sb as any, 'm1');
      expect(sb.from).toHaveBeenCalledWith('chat_messages');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'm1'] });
    });

    it('fetchChatGroupMembership scopes by group_id + user_id', async () => {
      const sb = makeSupabaseStub({ data: { role: 'member' } });
      await repo.fetchChatGroupMembership(sb as any, 'g1', 'u1');
      expect(sb.from).toHaveBeenCalledWith('chat_group_members');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['group_id', 'g1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
    });
  });

  describe('fanout helpers', () => {
    it('fetchChatGroupName selects name by id', async () => {
      const sb = makeSupabaseStub({ data: { name: 'My Group' } });
      await repo.fetchChatGroupName(sb as any, 'g1');
      expect(sb.from).toHaveBeenCalledWith('chat_groups');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['name'] });
    });

    it('listChatGroupMemberIds selects user_id by group_id', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.listChatGroupMemberIds(sb as any, 'g1');
      expect(sb.from).toHaveBeenCalledWith('chat_group_members');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['user_id'] });
    });

    it('listRecentChatGroupMessagesForHistory orders desc and limits', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.listRecentChatGroupMessagesForHistory(sb as any, 'g1', 13);
      expect(sb.calls).toContainEqual({ method: 'order', args: ['created_at', { ascending: false }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [13] });
    });
  });

  describe('welcome refanout helpers', () => {
    it('fetchChatGroupForRefanout selects id/tenant_id/name', async () => {
      const sb = makeSupabaseStub({ data: { id: 'g1', tenant_id: 't1', name: 'x' } });
      await repo.fetchChatGroupForRefanout(sb as any, 'g1');
      expect(sb.from).toHaveBeenCalledWith('chat_groups');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['id, tenant_id, name'] });
    });

    it('fetchChatGroupWelcomeMessage filters on metadata->>source and takes the earliest', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchChatGroupWelcomeMessage(sb as any, 'g1');
      expect(sb.from).toHaveBeenCalledWith('chat_messages');
      expect(sb.calls).toContainEqual({ method: 'filter', args: ['metadata->>source', 'eq', 'vitana_group_welcome'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['created_at', { ascending: true }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [1] });
    });
  });
});
