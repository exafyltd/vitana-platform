import * as repo from '../../src/services/automation-handlers/memory-intelligence-repository';

/**
 * Functional stub Supabase client — a from()-chain that records every call
 * and resolves to a configurable {data,error,count} response, matching the
 * pattern used for the other B1 repository tests.
 */
function makeSupabaseStub(response: { data?: any; error?: any; count?: number | null } = {}) {
  const calls: { method: string; args: any[] }[] = [];
  const resolved = { data: response.data ?? null, error: response.error ?? null, count: response.count ?? null };

  const chain: any = {};
  const record = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    return chain;
  };
  for (const m of [
    'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not', 'like', 'or', 'overlaps',
    'order', 'limit', 'range', 'filter', 'update', 'insert', 'upsert', 'delete',
  ]) {
    chain[m] = record(m);
  }
  chain.single = jest.fn(() => Promise.resolve(resolved));
  chain.maybeSingle = jest.fn(() => Promise.resolve(resolved));
  chain.then = (onResolve: (v: any) => void) => Promise.resolve(resolved).then(onResolve);

  const from = jest.fn((table: string) => {
    calls.push({ method: 'from', args: [table] });
    return chain;
  });
  const rpc = jest.fn((fn: string, args?: any) => {
    calls.push({ method: 'rpc', args: [fn, args] });
    return Promise.resolve(resolved);
  });

  return { from, rpc, calls, chain };
}

describe('memory-intelligence-repository', () => {
  describe('fetchDailyMatchById', () => {
    it('reads daily_matches by id', async () => {
      const sb = makeSupabaseStub({ data: { id: 'm1' } });
      await repo.fetchDailyMatchById(sb as any, 'm1');
      expect(sb.from).toHaveBeenCalledWith('daily_matches');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'm1'] });
      expect(sb.chain.maybeSingle).toHaveBeenCalled();
    });
  });

  describe('fetchRecentSelfFactValues', () => {
    it('scopes to tenant/user/entity=self, newest first, caller limit', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchRecentSelfFactValues(sb as any, 't1', 'u1', 3);
      expect(sb.from).toHaveBeenCalledWith('memory_facts');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['tenant_id', 't1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['entity', 'self'] });
      expect(sb.calls).toContainEqual({ method: 'is', args: ['superseded_at', null] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['extracted_at', { ascending: false }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [3] });
    });
  });

  describe('countRecentFactsForUser', () => {
    it('head-counts facts extracted since a cutoff', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countRecentFactsForUser(sb as any, 't1', 'u1', 'since-iso');
      expect(sb.from).toHaveBeenCalledWith('memory_facts');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['id', { count: 'exact', head: true }] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['extracted_at', 'since-iso'] });
    });
  });

  describe('fetchRecentActiveFacts', () => {
    it('does NOT filter by entity (unlike fetchRecentSelfFactValues)', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchRecentActiveFacts(sb as any, 't1', 'u1', 5);
      expect(sb.from).toHaveBeenCalledWith('memory_facts');
      expect(sb.calls.some((c) => c.method === 'eq' && c.args[0] === 'entity')).toBe(false);
      expect(sb.calls).toContainEqual({ method: 'limit', args: [5] });
    });
  });

  describe('fetchUserIdsWithRecentFacts', () => {
    it('uses gt (not gte) on extracted_at', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchUserIdsWithRecentFacts(sb as any, 't1', 'since-iso', 5000);
      expect(sb.calls).toContainEqual({ method: 'gt', args: ['extracted_at', 'since-iso'] });
    });
  });

  describe('fetchExistingPreferenceFacts', () => {
    it('scopes to user_preference_% keys for the given user set', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchExistingPreferenceFacts(sb as any, 't1', ['u1', 'u2']);
      expect(sb.calls).toContainEqual({ method: 'in', args: ['user_id', ['u1', 'u2']] });
      expect(sb.calls).toContainEqual({ method: 'like', args: ['fact_key', 'user_preference_%'] });
    });
  });

  describe('fetchNameFactsForGraphProjection', () => {
    it('filters fact_key by %name%', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchNameFactsForGraphProjection(sb as any, 't1', 1000);
      expect(sb.calls).toContainEqual({ method: 'like', args: ['fact_key', '%name%'] });
    });
  });

  describe('fetchFactsMissingEmbedding / updateFactEmbedding', () => {
    it('fetch filters embedding is null', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchFactsMissingEmbedding(sb as any, 't1', 100);
      expect(sb.calls).toContainEqual({ method: 'is', args: ['embedding', null] });
    });

    it('update writes the embedding patch by row id', async () => {
      const sb = makeSupabaseStub({ data: null });
      const patch = { embedding: '[1,2]', embedding_model: 'm', embedding_updated_at: 'now' };
      await repo.updateFactEmbedding(sb as any, 'row1', patch);
      expect(sb.calls).toContainEqual({ method: 'update', args: [patch] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'row1'] });
    });
  });

  describe('fetchAllActiveFactUserIds', () => {
    it('has no per-user filter (unlike fetchRecentSelfFactValues)', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchAllActiveFactUserIds(sb as any, 't1', 10000);
      expect(sb.calls.some((c) => c.method === 'eq' && c.args[0] === 'user_id')).toBe(false);
      expect(sb.calls).toContainEqual({ method: 'limit', args: [10000] });
    });
  });

  describe('rpcWriteFact', () => {
    it('forwards args to the write_fact RPC verbatim', async () => {
      const sb = makeSupabaseStub({ data: null });
      const args = {
        p_tenant_id: 't1', p_user_id: 'u1', p_fact_key: 'k', p_fact_value: 'v',
        p_entity: 'self', p_fact_value_type: 'text', p_provenance_source: 'behavior_inferred',
        p_provenance_confidence: 0.55,
      };
      await repo.rpcWriteFact(sb as any, args);
      expect(sb.rpc).toHaveBeenCalledWith('write_fact', args);
    });
  });

  describe('fetchKnowledgeDocByTags', () => {
    it('uses overlaps() against the tags array', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchKnowledgeDocByTags(sb as any, ['sleep', 'stress'], 1);
      expect(sb.from).toHaveBeenCalledWith('knowledge_docs');
      expect(sb.calls).toContainEqual({ method: 'overlaps', args: ['tags', ['sleep', 'stress']] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [1] });
    });
  });

  describe('fetchCalendarEventUserIdsSince', () => {
    it('excludes null user_id', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchCalendarEventUserIdsSince(sb as any, 'since-iso', 5000);
      expect(sb.from).toHaveBeenCalledWith('calendar_events');
      expect(sb.calls).toContainEqual({ method: 'not', args: ['user_id', 'is', null] });
    });
  });

  describe('fetchAssistantStateSignal', () => {
    it('scopes by tenant, user, and signal_name', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchAssistantStateSignal(sb as any, 't1', 'u1', 'greeting_facts');
      expect(sb.from).toHaveBeenCalledWith('user_assistant_state');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['signal_name', 'greeting_facts'] });
    });
  });

  describe('fetchHighConfidenceRoutines', () => {
    it('orders by confidence descending above the given floor', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchHighConfidenceRoutines(sb as any, 0.6, 3000);
      expect(sb.from).toHaveBeenCalledWith('user_routines');
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['confidence', 0.6] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['confidence', { ascending: false }] });
    });
  });

  describe('fetchExistingPersonNode / insertPersonNode', () => {
    it('fetch scopes by tenant, node_type=person, title, and owner metadata', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchExistingPersonNode(sb as any, 't1', 'Maria', 'u1');
      expect(sb.from).toHaveBeenCalledWith('relationship_nodes');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['node_type', 'person'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['title', 'Maria'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['metadata->>owner_user_id', 'u1'] });
    });

    it('insert selects back the id (single)', async () => {
      const sb = makeSupabaseStub({ data: { id: 'n1' } });
      const row = { tenant_id: 't1', node_type: 'person' };
      await repo.insertPersonNode(sb as any, row);
      expect(sb.calls).toContainEqual({ method: 'insert', args: [row] });
      expect(sb.calls).toContainEqual({ method: 'select', args: ['id'] });
      expect(sb.chain.single).toHaveBeenCalled();
    });
  });

  describe('fetchExistingSuggestedEdge vs fetchExistingConnectedEdge', () => {
    it('suggested-edge lookup filters edge_type=suggested', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchExistingSuggestedEdge(sb as any, 't1', 'src1', 'tgt1');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['edge_type', 'suggested'] });
    });

    it('connected-edge lookup filters edge_type=connected', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchExistingConnectedEdge(sb as any, 't1', 'src1', 'tgt1');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['edge_type', 'connected'] });
    });
  });

  describe('updateEdgeLastInteraction / insertRelationshipEdge', () => {
    it('update patches last_interaction_at + updated_at by edge id', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.updateEdgeLastInteraction(sb as any, 'edge1', 'interaction-iso', 'updated-iso');
      expect(sb.from).toHaveBeenCalledWith('relationship_edges');
      expect(sb.calls).toContainEqual({
        method: 'update',
        args: [{ last_interaction_at: 'interaction-iso', updated_at: 'updated-iso' }],
      });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'edge1'] });
    });

    it('insert is a plain row insert reused by both suggested and connected edges', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { tenant_id: 't1', edge_type: 'suggested' };
      await repo.insertRelationshipEdge(sb as any, row);
      expect(sb.calls).toContainEqual({ method: 'insert', args: [row] });
    });
  });

  describe('fetchFollowPairs', () => {
    it('reads follower_id/following_id with the caller limit', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchFollowPairs(sb as any, 5000);
      expect(sb.from).toHaveBeenCalledWith('user_follows');
      expect(sb.calls).toContainEqual({ method: 'limit', args: [5000] });
    });
  });

  describe('fetchRecentIndexScores', () => {
    it('reads all five pillar columns ordered oldest-first', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchRecentIndexScores(sb as any, 't1', 'since-date', 10000);
      expect(sb.from).toHaveBeenCalledWith('vitana_index_scores');
      expect(sb.calls).toContainEqual({ method: 'order', args: ['date', { ascending: true }] });
    });
  });

  describe('fetchRecentDiaryEntries', () => {
    it('has no tenant filter (matches the original inline query)', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchRecentDiaryEntries(sb as any, 'since-iso', 5000);
      expect(sb.from).toHaveBeenCalledWith('diary_entries');
      expect(sb.calls.some((c) => c.method === 'eq' && c.args[0] === 'tenant_id')).toBe(false);
    });
  });

  describe('fetchRecentPostsForCapture', () => {
    it('excludes rejected moderation status, orders oldest-first', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchRecentPostsForCapture(sb as any, 'since-iso', 300);
      expect(sb.from).toHaveBeenCalledWith('profile_posts');
      expect(sb.calls).toContainEqual({ method: 'neq', args: ['moderation_status', 'rejected'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['created_at', { ascending: true }] });
    });
  });

  describe('fetchMirroredPostIds', () => {
    it('builds the content_json->>post_id IN(...) filter string exactly as the original inline code did', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchMirroredPostIds(sb as any, 't1', ['p1', 'p2']);
      expect(sb.from).toHaveBeenCalledWith('memory_items');
      expect(sb.calls).toContainEqual({ method: 'filter', args: ['content_json->>post_id', 'in', '(p1,p2)'] });
    });
  });
});
