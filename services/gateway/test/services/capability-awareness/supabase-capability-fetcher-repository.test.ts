import * as repo from '../../../src/services/capability-awareness/supabase-capability-fetcher-repository';

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
    'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not', 'like', 'or',
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

  return { from, calls, chain };
}

describe('supabase-capability-fetcher-repository', () => {
  describe('fetchEnabledCapabilities', () => {
    it('filters to enabled=true', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchEnabledCapabilities(sb as any);
      expect(sb.from).toHaveBeenCalledWith('system_capabilities');
      expect(sb.calls).toContainEqual({
        method: 'select',
        args: [
          'capability_key, display_name, description, required_role, required_tenant_features, required_integrations, helpful_for_intents, enabled',
        ],
      });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['enabled', true] });
    });
  });

  describe('fetchUserCapabilityAwareness', () => {
    it('scopes by tenant_id + user_id', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchUserCapabilityAwareness(sb as any, 't1', 'u1');
      expect(sb.from).toHaveBeenCalledWith('user_capability_awareness');
      expect(sb.calls).toContainEqual({
        method: 'select',
        args: [
          'capability_key, awareness_state, first_introduced_at, last_introduced_at, first_used_at, last_used_at, use_count, dismiss_count, mastery_confidence, last_surface',
        ],
      });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['tenant_id', 't1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
    });
  });
});
