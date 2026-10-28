import * as repo from '../../src/services/admin-awareness-worker-repository';

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

describe('admin-awareness-worker-repository', () => {
  describe('fetchAllTenants', () => {
    it('selects tenant_id, is_active with no filter', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchAllTenants(sb as any);
      expect(sb.from).toHaveBeenCalledWith('tenants');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['tenant_id, is_active'] });
    });
  });

  describe('countTenantMembers / countTenantSignupsSince / countTenantSignupsBetween', () => {
    it('countTenantMembers has no date filter', async () => {
      const sb = makeSupabaseStub({ count: 5 });
      await repo.countTenantMembers(sb as any, 't1');
      expect(sb.from).toHaveBeenCalledWith('user_tenants');
      expect(sb.calls.some((c) => c.method === 'gte')).toBe(false);
    });

    it('countTenantSignupsSince filters by gte created_at only', async () => {
      const sb = makeSupabaseStub({ count: 2 });
      await repo.countTenantSignupsSince(sb as any, 't1', 'd1-iso');
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['created_at', 'd1-iso'] });
      expect(sb.calls.some((c) => c.method === 'lt')).toBe(false);
    });

    it('countTenantSignupsBetween filters gte+lt created_at (prior-week window)', async () => {
      const sb = makeSupabaseStub({ count: 1 });
      await repo.countTenantSignupsBetween(sb as any, 't1', 'd14-iso', 'd7-iso');
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['created_at', 'd14-iso'] });
      expect(sb.calls).toContainEqual({ method: 'lt', args: ['created_at', 'd7-iso'] });
    });
  });

  describe('countPendingInvitations / countExpiringInvitations', () => {
    it('pending requires both accepted_at and revoked_at to be null', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countPendingInvitations(sb as any, 't1');
      expect(sb.from).toHaveBeenCalledWith('tenant_invitations');
      expect(sb.calls).toContainEqual({ method: 'is', args: ['accepted_at', null] });
      expect(sb.calls).toContainEqual({ method: 'is', args: ['revoked_at', null] });
    });

    it('expiring bounds expires_at between from (gte) and to (lte), matching the original call-site argument order', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countExpiringInvitations(sb as any, 't1', 'now-iso', 'd48h-iso');
      expect(sb.calls).toContainEqual({ method: 'lte', args: ['expires_at', 'd48h-iso'] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['expires_at', 'now-iso'] });
    });
  });

  describe('countTenantEventsInWindow', () => {
    it('bounds start_time between from (gte) and to (lt), reused for this-week and next-week', async () => {
      const sb = makeSupabaseStub({ count: 3 });
      await repo.countTenantEventsInWindow(sb as any, 't1', 'now-iso', 'in7d-iso');
      expect(sb.from).toHaveBeenCalledWith('global_community_events');
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['start_time', 'now-iso'] });
      expect(sb.calls).toContainEqual({ method: 'lt', args: ['start_time', 'in7d-iso'] });
    });
  });

  describe('countAllCommunityGroups', () => {
    it('has no tenant filter (global count, not per-tenant)', async () => {
      const sb = makeSupabaseStub({ count: 10 });
      await repo.countAllCommunityGroups(sb as any);
      expect(sb.from).toHaveBeenCalledWith('global_community_groups');
      expect(sb.calls.some((c) => c.method === 'eq')).toBe(false);
    });
  });

  describe('countActiveLiveRooms', () => {
    it('scopes by tenant and ends_at in the future', async () => {
      const sb = makeSupabaseStub({ count: 1 });
      await repo.countActiveLiveRooms(sb as any, 't1', 'now-iso');
      expect(sb.from).toHaveBeenCalledWith('live_rooms');
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['ends_at', 'now-iso'] });
    });
  });

  describe('countNewMembershipsSince', () => {
    it('scopes by tenant and created_at cutoff', async () => {
      const sb = makeSupabaseStub({ count: 2 });
      await repo.countNewMembershipsSince(sb as any, 't1', 'd7-iso');
      expect(sb.from).toHaveBeenCalledWith('community_memberships');
    });
  });

  describe('countAutopilotRunsSince / countAutopilotRunsByStatusSince', () => {
    it('the plain since-count has no status filter', async () => {
      const sb = makeSupabaseStub({ count: 4 });
      await repo.countAutopilotRunsSince(sb as any, 't1', 'd1-iso');
      expect(sb.from).toHaveBeenCalledWith('tenant_autopilot_runs');
      expect(sb.calls.some((c) => c.method === 'eq' && c.args[0] === 'status')).toBe(false);
    });

    it('the by-status count adds an eq(status) filter, reused for completed/failed', async () => {
      const sb = makeSupabaseStub({ count: 1 });
      await repo.countAutopilotRunsByStatusSince(sb as any, 't1', 'd7-iso', 'failed');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'failed'] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['started_at', 'd7-iso'] });
    });
  });

  describe('countRecommendationsByStatus / countRecommendationsByStatusSince', () => {
    it('the plain status count has no date filter', async () => {
      const sb = makeSupabaseStub({ count: 3 });
      await repo.countRecommendationsByStatus(sb as any, 'new');
      expect(sb.from).toHaveBeenCalledWith('autopilot_recommendations');
      expect(sb.calls.some((c) => c.method === 'gte')).toBe(false);
    });

    it('the since-scoped count adds updated_at gte', async () => {
      const sb = makeSupabaseStub({ count: 1 });
      await repo.countRecommendationsByStatusSince(sb as any, 'activated', 'd7-iso');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'activated'] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['updated_at', 'd7-iso'] });
    });
  });

  describe('upsertTenantKpiCurrent / upsertTenantKpiDaily', () => {
    it('current conflicts on tenant_id alone', async () => {
      const sb = makeSupabaseStub({ error: null });
      const row = { tenant_id: 't1', kpi: {} };
      await repo.upsertTenantKpiCurrent(sb as any, row);
      expect(sb.from).toHaveBeenCalledWith('tenant_kpi_current');
      expect(sb.calls).toContainEqual({ method: 'upsert', args: [row, { onConflict: 'tenant_id' }] });
    });

    it('daily conflicts on tenant_id,snapshot_date', async () => {
      const sb = makeSupabaseStub({ error: null });
      const row = { tenant_id: 't1', snapshot_date: '2026-01-01', kpi: {} };
      await repo.upsertTenantKpiDaily(sb as any, row);
      expect(sb.from).toHaveBeenCalledWith('tenant_kpi_daily');
      expect(sb.calls).toContainEqual({ method: 'upsert', args: [row, { onConflict: 'tenant_id,snapshot_date' }] });
    });
  });
});
