import * as repo from '../../../src/services/guided-journey/checklist-publish-repository';

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

const VERSION_SELECT =
  'id, version_label, curriculum_version, status, session_count, topic_count, is_current, note, published_by, published_at';

describe('checklist-publish-repository', () => {
  describe('fetchVersionsByCurriculum', () => {
    it('scopes by curriculum_version, newest-published-first', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchVersionsByCurriculum(sb as any, 'v2');
      expect(sb.from).toHaveBeenCalledWith('journey_checklist_versions');
      expect(sb.calls).toContainEqual({ method: 'select', args: [VERSION_SELECT] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['curriculum_version', 'v2'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['published_at', { ascending: false }] });
    });
  });

  describe('unsetCurrentVersion', () => {
    it('unsets is_current for the curriculum line', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.unsetCurrentVersion(sb as any, 'v2');
      expect(sb.from).toHaveBeenCalledWith('journey_checklist_versions');
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ is_current: false }] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['curriculum_version', 'v2'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['is_current', true] });
    });
  });

  describe('insertPublishedVersion', () => {
    it('inserts the row and selects the version shape back', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { version_label: 'v2-2026', curriculum_version: 'v2' };
      await repo.insertPublishedVersion(sb as any, row);
      expect(sb.from).toHaveBeenCalledWith('journey_checklist_versions');
      expect(sb.calls).toContainEqual({ method: 'insert', args: [row] });
      expect(sb.calls).toContainEqual({ method: 'select', args: [VERSION_SELECT] });
    });
  });

  describe('fetchVersionForRollback', () => {
    it('scopes by id, single row', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchVersionForRollback(sb as any, 'ver-1');
      expect(sb.from).toHaveBeenCalledWith('journey_checklist_versions');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['id, curriculum_version'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'ver-1'] });
    });
  });

  describe('setVersionCurrent', () => {
    it('sets is_current + status=published for the given id', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.setVersionCurrent(sb as any, 'ver-1');
      expect(sb.from).toHaveBeenCalledWith('journey_checklist_versions');
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ is_current: true, status: 'published' }] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'ver-1'] });
      expect(sb.calls).toContainEqual({ method: 'select', args: [VERSION_SELECT] });
    });
  });

  describe('insertChecklistAudit', () => {
    it('inserts into journey_checklist_audit', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { actor_admin_id: 'a1', action: 'publish', version_id: 'ver-1', detail: 'x' };
      await repo.insertChecklistAudit(sb as any, row);
      expect(sb.from).toHaveBeenCalledWith('journey_checklist_audit');
      expect(sb.calls).toContainEqual({ method: 'insert', args: [row] });
    });
  });
});
