import * as repo from '../../../src/services/guided-journey/checklist-service-repository';

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
    'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not', 'like', 'ilike', 'or',
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

describe('checklist-service-repository', () => {
  describe('listChecklistTopics', () => {
    it('defaults curriculum_version to v2, orders session then position', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.listChecklistTopics(sb as any, {});
      expect(sb.from).toHaveBeenCalledWith('journey_checklist_topics');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['curriculum_version', 'v2'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['session', { ascending: true }] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['position', { ascending: true }] });
    });

    it('applies session/chapterId/status/businessGate/search filters when provided', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.listChecklistTopics(sb as any, {
        curriculumVersion: 'v3',
        session: 2,
        chapterId: 'ch1',
        status: 'draft' as any,
        businessGate: 'free' as any,
        search: 'sleep',
      });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['curriculum_version', 'v3'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['session', 2] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['chapter_id', 'ch1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'draft'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['business_gate', 'free'] });
      expect(sb.calls).toContainEqual({ method: 'ilike', args: ['display_label', '%sleep%'] });
    });
  });

  describe('fetchChecklistTopicById', () => {
    it('scopes by topic_id, single row', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchChecklistTopicById(sb as any, 't1');
      expect(sb.from).toHaveBeenCalledWith('journey_checklist_topics');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['topic_id', 't1'] });
    });
  });

  describe('updateChecklistTopic', () => {
    it('updates by topic_id and selects the row back', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { display_label: 'x' };
      await repo.updateChecklistTopic(sb as any, 't1', row);
      expect(sb.from).toHaveBeenCalledWith('journey_checklist_topics');
      expect(sb.calls).toContainEqual({ method: 'update', args: [row] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['topic_id', 't1'] });
    });
  });

  describe('insertChecklistTopic', () => {
    it('inserts and selects the row back', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { topic_id: 't1' };
      await repo.insertChecklistTopic(sb as any, row);
      expect(sb.from).toHaveBeenCalledWith('journey_checklist_topics');
      expect(sb.calls).toContainEqual({ method: 'insert', args: [row] });
    });
  });

  describe('setChecklistTopicDisabled', () => {
    it('updates by topic_id and selects the row back', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { status: 'disabled', enabled: false };
      await repo.setChecklistTopicDisabled(sb as any, 't1', row);
      expect(sb.from).toHaveBeenCalledWith('journey_checklist_topics');
      expect(sb.calls).toContainEqual({ method: 'update', args: [row] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['topic_id', 't1'] });
    });
  });

  describe('insertChecklistServiceAudit', () => {
    it('inserts into journey_checklist_audit', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { actor_admin_id: 'a1', action: 'update' };
      await repo.insertChecklistServiceAudit(sb as any, row);
      expect(sb.from).toHaveBeenCalledWith('journey_checklist_audit');
      expect(sb.calls).toContainEqual({ method: 'insert', args: [row] });
    });
  });

  describe('fetchCurrentVersionSnapshot', () => {
    it('scopes by curriculum_version + is_current, single row', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchCurrentVersionSnapshot(sb as any, 'v2');
      expect(sb.from).toHaveBeenCalledWith('journey_checklist_versions');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['version_label, snapshot'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['curriculum_version', 'v2'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['is_current', true] });
    });
  });

  describe('fetchCurrentVersionSnapshotOnly', () => {
    it('scopes by curriculum_version + is_current, single row, snapshot column only', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchCurrentVersionSnapshotOnly(sb as any, 'v2');
      expect(sb.from).toHaveBeenCalledWith('journey_checklist_versions');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['snapshot'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['curriculum_version', 'v2'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['is_current', true] });
    });
  });

  describe('fetchChecklistTranslationRows', () => {
    it('scopes by locale + topic_id list', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchChecklistTranslationRows(sb as any, 'de', ['t1', 't2']);
      expect(sb.from).toHaveBeenCalledWith('journey_checklist_translations');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['locale', 'de'] });
      expect(sb.calls).toContainEqual({ method: 'in', args: ['topic_id', ['t1', 't2']] });
    });
  });
});
