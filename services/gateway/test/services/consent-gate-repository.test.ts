import * as repo from '../../src/services/consent-gate-repository';

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

describe('consent-gate-repository', () => {
  describe('fetchBlanketGrant', () => {
    it('scopes to user_id, action_type, and granted=true', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchBlanketGrant(sb as any, 'u1', 'shopping_add_to_list');
      expect(sb.from).toHaveBeenCalledWith('user_action_permissions');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['action_type', 'shopping_add_to_list'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['granted', true] });
    });
  });

  describe('insertPendingAction', () => {
    it('inserts the row and selects back the full pending-action shape', async () => {
      const sb = makeSupabaseStub({ data: { id: 'a1', state: 'pending' } });
      const row = { tenant_id: 't1', user_id: 'u1', action_type: 'custom' };
      await repo.insertPendingAction(sb as any, row);
      expect(sb.from).toHaveBeenCalledWith('pending_connector_actions');
      expect(sb.calls).toContainEqual({ method: 'insert', args: [row] });
      expect(sb.calls).toContainEqual({
        method: 'select',
        args: ['id, state, action_type, preview_title, preview_description, preview_data, requested_by, requested_at, expires_at, connector_id, product_id'],
      });
      expect(sb.chain.single).toHaveBeenCalled();
    });
  });

  describe('fetchPendingActionForApproval', () => {
    it('scopes by id AND user_id (ownership check)', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchPendingActionForApproval(sb as any, 'a1', 'u1');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'a1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.chain.single).toHaveBeenCalled();
    });
  });

  describe('markActionExpired / markActionApproved / markActionDenied', () => {
    it('expired sets only state', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.markActionExpired(sb as any, 'a1');
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ state: 'expired' }] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'a1'] });
    });

    it('approved sets state + approved_at', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.markActionApproved(sb as any, 'a1', 'now-iso');
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ state: 'approved', approved_at: 'now-iso' }] });
    });

    it('denied sets state + denied_at, scoped by id AND user_id', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.markActionDenied(sb as any, 'a1', 'u1', 'now-iso');
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ state: 'denied', denied_at: 'now-iso' }] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'a1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
    });
  });

  describe('fetchActionForAudit', () => {
    it('reads the audit-relevant columns by id', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchActionForAudit(sb as any, 'a1');
      expect(sb.calls).toContainEqual({
        method: 'select',
        args: ['tenant_id, action_type, capability, args, preview_title, requested_by, requested_at, vtid, recommendation_id, product_id'],
      });
    });
  });

  describe('fetchUserPendingActionsList', () => {
    it('scopes to user + state=pending, newest-first, caller limit', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchUserPendingActionsList(sb as any, 'u1', 10);
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['state', 'pending'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['requested_at', { ascending: false }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [10] });
    });
  });

  describe('fetchFullPendingAction', () => {
    it('reads all columns (select *) by id', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchFullPendingAction(sb as any, 'a1');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['*'] });
    });
  });

  describe('markActionExecuting / markActionFailed / markActionExecuted', () => {
    it('executing sets only state', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.markActionExecuting(sb as any, 'a1');
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ state: 'executing' }] });
    });

    it('failed merges the patch under state=failed (reused across the no-executor, executor-false, and catch-block call sites)', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.markActionFailed(sb as any, 'a1', { error: 'boom', failed_at: 'now-iso' });
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ state: 'failed', error: 'boom', failed_at: 'now-iso' }] });
    });

    it('executed merges the patch under state=executed', async () => {
      const sb = makeSupabaseStub({ data: null });
      const patch = { result: { ok: true }, external_id: 'ext1', reversal_handle: null, executed_at: 'now-iso' };
      await repo.markActionExecuted(sb as any, 'a1', patch);
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ state: 'executed', ...patch }] });
    });
  });

  describe('bulkExpirePendingActions', () => {
    it('matches only pending + already-expired rows, selects back ids', async () => {
      const sb = makeSupabaseStub({ data: [{ id: 'a1' }] });
      await repo.bulkExpirePendingActions(sb as any, 'now-iso');
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ state: 'expired' }] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['state', 'pending'] });
      expect(sb.calls).toContainEqual({ method: 'lt', args: ['expires_at', 'now-iso'] });
      expect(sb.calls).toContainEqual({ method: 'select', args: ['id'] });
    });
  });

  describe('insertActionLedgerEntry', () => {
    it('inserts into action_ledger verbatim (reused by deny, no-executor, and execute-result paths)', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { tenant_id: 't1', user_id: 'u1', action_id: 'a1', outcome: 'denied' };
      await repo.insertActionLedgerEntry(sb as any, row);
      expect(sb.from).toHaveBeenCalledWith('action_ledger');
      expect(sb.calls).toContainEqual({ method: 'insert', args: [row] });
    });
  });
});
