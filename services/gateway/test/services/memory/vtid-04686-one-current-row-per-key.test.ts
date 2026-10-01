/**
 * VTID-04686: after every successful write, rememberFact() retires every
 * other current row of the key — other entities included. write_fact keeps
 * one current row per (key, entity), so a Memory Garden value (self) and the
 * same fact inferred from speech (disclosed) both stayed current; the live
 * suite read "paul_birthday=May 5th" next to "paul_birthday=May 5" (B-CONF-04).
 */
const mockEmit = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...a: any[]) => mockEmit(...a),
}));

import { rememberFact } from '../../../src/services/memory/remember';

const base = {
  tenant_id: 't1',
  user_id: 'u1',
  fact_key: 'paul_birthday',
  fact_value: 'May 5th',
  entity: 'disclosed',
  provenance_source: 'assistant_inferred',
  provenance_confidence: 0.8,
  actor: 'test',
};

function fakeClient(opts: { updateError?: string } = {}) {
  const calls: any = { update: null, filters: [] as Array<[string, string, unknown]> };
  const chain: any = {
    update(v: any) { calls.update = v; return chain; },
    eq(c: string, v: unknown) { calls.filters.push(['eq', c, v]); return chain; },
    is(c: string, v: unknown) { calls.filters.push(['is', c, v]); return chain; },
    neq(c: string, v: unknown) {
      calls.filters.push(['neq', c, v]);
      return Promise.resolve({ error: opts.updateError ? { message: opts.updateError } : null });
    },
  };
  const client = {
    rpc: jest.fn().mockResolvedValue({ data: 'new-row', error: null }),
    from: jest.fn().mockReturnValue(chain),
  };
  return { client, calls };
}

describe('VTID-04686 rememberFact retires other current rows of the key', () => {
  it('supersedes every other current row of the same key, whatever its entity', async () => {
    const { client, calls } = fakeClient();
    const r = await rememberFact(base, { client: client as any, embed: false, forgottenStore: null });
    expect(r).toEqual({ ok: true, fact_id: 'new-row' });
    expect(client.from).toHaveBeenCalledWith('memory_facts');
    expect(calls.update).toMatchObject({ superseded_by: 'new-row' });
    expect(typeof calls.update.superseded_at).toBe('string');
    expect(calls.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'tenant_id', 't1'],
        ['eq', 'user_id', 'u1'],
        ['eq', 'fact_key', 'paul_birthday'],
        ['is', 'superseded_at', null],
        ['neq', 'id', 'new-row'],
      ]),
    );
    // Never filtered by entity: that filter is exactly the gap.
    expect(calls.filters.find(([, c]: any) => c === 'entity')).toBeUndefined();
  });

  it('keeps the write when retiring fails', async () => {
    const { client } = fakeClient({ updateError: 'boom' });
    const r = await rememberFact(base, { client: client as any, embed: false, forgottenStore: null });
    expect(r).toEqual({ ok: true, fact_id: 'new-row' });
  });

  it('does nothing extra when retireOthers is false', async () => {
    const { client } = fakeClient();
    await rememberFact(base, { client: client as any, embed: false, forgottenStore: null, retireOthers: false });
    expect(client.from).not.toHaveBeenCalled();
  });

  it('does not retire anything when the write failed', async () => {
    const { client } = fakeClient();
    client.rpc.mockResolvedValue({ data: null, error: { message: 'rpc down' } });
    const r = await rememberFact(base, { client: client as any, embed: false, forgottenStore: null });
    expect(r.ok).toBe(false);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('uses a PATCH on the REST transport scoped to the key, never the new row', async () => {
    const fetchMock = jest.fn(async (url: string, init: any) => {
      if (String(url).endsWith('/rpc/write_fact')) return { ok: true, json: async () => 'rest-row' } as any;
      return { ok: true, text: async () => '', json: async () => [] } as any;
    });
    (global as any).fetch = fetchMock;
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE = 'svc-key';
    const r = await rememberFact(base, { embed: false, forgottenStore: null });
    expect(r).toEqual({ ok: true, fact_id: 'rest-row' });
    const patch = fetchMock.mock.calls.find(([, init]: any[]) => init?.method === 'PATCH');
    expect(patch).toBeDefined();
    const url = String(patch![0]);
    expect(url).toContain('/rest/v1/memory_facts?');
    expect(url).toContain('fact_key=eq.paul_birthday');
    expect(url).toContain('id=neq.rest-row');
    expect(url).toContain('superseded_at=is.null');
    expect(JSON.parse(patch![1].body)).toMatchObject({ superseded_by: 'rest-row' });
  });
});
