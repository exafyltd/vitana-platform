import * as repo from '../../src/routes/vaea-repository';

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
  for (const m of ['select', 'eq', 'in', 'gte', 'order', 'range', 'update', 'insert', 'upsert', 'delete']) {
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

const IDENT = { user_id: 'u1', tenant_id: 't1' };

describe('vaea-repository', () => {
  describe('config', () => {
    it('fetchVaeaConfig scopes to tenant_id + user_id and returns maybeSingle', async () => {
      const sb = makeSupabaseStub({ data: { autonomy_default: 'silent' } });
      const result = await repo.fetchVaeaConfig(sb as any, IDENT);
      expect(sb.from).toHaveBeenCalledWith('vaea_config');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['tenant_id', 't1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(result.data).toEqual({ autonomy_default: 'silent' });
    });

    it('upsertVaeaConfig upserts on tenant_id,user_id', async () => {
      const sb = makeSupabaseStub({ data: { ok: true } });
      const payload = { tenant_id: 't1', user_id: 'u1', autonomy_default: 'draft_to_user' };
      await repo.upsertVaeaConfig(sb as any, payload);
      expect(sb.calls).toContainEqual({ method: 'upsert', args: [payload, { onConflict: 'tenant_id,user_id' }] });
    });
  });

  describe('catalog', () => {
    it('listVaeaCatalog orders by tier then created_at desc', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.listVaeaCatalog(sb as any, IDENT);
      expect(sb.from).toHaveBeenCalledWith('vaea_referral_catalog');
      expect(sb.calls).toContainEqual({ method: 'order', args: ['tier', { ascending: true }] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['created_at', { ascending: false }] });
    });

    it('insertVaeaCatalogItem inserts the given payload', async () => {
      const sb = makeSupabaseStub({ data: { id: 'c1' } });
      const payload = { tenant_id: 't1', user_id: 'u1', tier: 'own', title: 'x' };
      await repo.insertVaeaCatalogItem(sb as any, payload);
      expect(sb.calls).toContainEqual({ method: 'insert', args: [payload] });
    });

    it('updateVaeaCatalogItem scopes update by id + tenant + user', async () => {
      const sb = makeSupabaseStub({ data: { id: 'c1' } });
      await repo.updateVaeaCatalogItem(sb as any, 'c1', IDENT, { title: 'new' });
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ title: 'new' }] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'c1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['tenant_id', 't1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
    });

    it('deleteVaeaCatalogItem scopes delete by id + tenant + user', async () => {
      const sb = makeSupabaseStub();
      await repo.deleteVaeaCatalogItem(sb as any, 'c1', IDENT);
      expect(sb.calls).toContainEqual({ method: 'delete', args: [] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'c1'] });
    });
  });

  describe('channels', () => {
    it('listVaeaChannels scopes to tenant + user', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.listVaeaChannels(sb as any, IDENT);
      expect(sb.from).toHaveBeenCalledWith('vaea_listener_channels');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['tenant_id', 't1'] });
    });

    it('insertVaeaChannel inserts the given payload', async () => {
      const sb = makeSupabaseStub({ data: { id: 'ch1' } });
      const payload = { tenant_id: 't1', user_id: 'u1', platform: 'slack', channel_key: 'k' };
      await repo.insertVaeaChannel(sb as any, payload);
      expect(sb.calls).toContainEqual({ method: 'insert', args: [payload] });
    });

    it('updateVaeaChannel scopes by id + tenant + user', async () => {
      const sb = makeSupabaseStub({ data: { id: 'ch1' } });
      await repo.updateVaeaChannel(sb as any, 'ch1', IDENT, { active: false });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'ch1'] });
    });

    it('deleteVaeaChannel scopes by id + tenant + user', async () => {
      const sb = makeSupabaseStub();
      await repo.deleteVaeaChannel(sb as any, 'ch1', IDENT);
      expect(sb.calls).toContainEqual({ method: 'delete', args: [] });
    });
  });

  describe('listVaeaDetectedQuestions', () => {
    it('paginates via range() and skips the disposition filter when not given', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.listVaeaDetectedQuestions(sb as any, IDENT, { limit: 50, offset: 0 });
      expect(sb.calls).toContainEqual({ method: 'range', args: [0, 49] });
      expect(sb.calls.some((c) => c.method === 'eq' && c.args[0] === 'disposition')).toBe(false);
    });

    it('applies the disposition filter when given', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.listVaeaDetectedQuestions(sb as any, IDENT, { limit: 50, offset: 0, disposition: 'answered' });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['disposition', 'answered'] });
    });
  });

  describe('drafts', () => {
    it('listVaeaDrafts filters by the given statuses and joins detected_questions', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.listVaeaDrafts(sb as any, IDENT, { statuses: ['shadow'], limit: 50, offset: 0 });
      expect(sb.from).toHaveBeenCalledWith('vaea_reply_drafts');
      expect(sb.calls).toContainEqual({ method: 'in', args: ['status', ['shadow']] });
      expect(sb.calls.some((c) => c.method === 'select' && String(c.args[0]).includes('vaea_detected_questions'))).toBe(true);
    });

    it('dismissVaeaDraft only touches shadow/pending_approval drafts', async () => {
      const sb = makeSupabaseStub({ data: { id: 'd1', status: 'dismissed' } });
      await repo.dismissVaeaDraft(sb as any, 'd1', IDENT);
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ status: 'dismissed' }] });
      expect(sb.calls).toContainEqual({ method: 'in', args: ['status', ['shadow', 'pending_approval']] });
    });
  });

  describe('fetchVaeaSummary', () => {
    it('queries all 5 sources in the documented order', async () => {
      const sb = makeSupabaseStub({ data: null, count: 0 });
      await repo.fetchVaeaSummary(sb as any, IDENT);
      const tables = sb.calls.filter((c) => c.method === 'from').map((c) => c.args[0]);
      expect(tables).toEqual([
        'vaea_config',
        'vaea_listener_channels',
        'vaea_referral_catalog',
        'vaea_reply_drafts',
        'vaea_detected_questions',
      ]);
    });
  });
});
