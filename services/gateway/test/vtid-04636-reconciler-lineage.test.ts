/**
 * VTID-04636: the self-healing reconciler judges a VTID by its self-heal
 * lineage. Live case (2026-09-26): VTID-04608 / VTID-04614 were closed
 * `failed` when the parent execution turned `reverted` at the first red CI,
 * although fix mode continued on the same PR and the child completed.
 */
import { reconcileAutopilotLinkedSelfHealingVtids, resolveExecutionLineageTail } from '../src/services/self-healing-reconciler';

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

const ORIGINAL_FETCH = global.fetch;

type Row = { id: string; status: string; parent?: string | null; created_at?: string; pr_url?: string | null };

function mock(rows: Row[], ledger: Array<{ vtid: string; execId: string }>, opts: { childLookupFails?: boolean } = {}) {
  const patches: Array<{ vtid: string; body: any }> = [];
  const full = (r: Row) => ({ id: r.id, status: r.status, pr_url: r.pr_url ?? null, pr_number: null, branch: null, metadata: {}, completed_at: null });
  global.fetch = jest.fn().mockImplementation(async (url: string, init?: any) => {
    const method = init?.method || 'GET';
    if (url.includes('/rest/v1/vtid_ledger?metadata->>autopilot_execution_id=not.is.null')) {
      return { ok: true, json: async () => ledger.map(l => ({ vtid: l.vtid, metadata: { autopilot_execution_id: l.execId } })) };
    }
    const child = url.match(/dev_autopilot_executions\?parent_execution_id=eq\.([^&]+)/);
    if (child) {
      if (opts.childLookupFails) return { ok: false, status: 503, json: async () => ({}) };
      const kids = rows.filter(r => r.parent === decodeURIComponent(child[1]))
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
      return { ok: true, json: async () => kids.slice(0, 1).map(full) };
    }
    const byId = url.match(/dev_autopilot_executions\?id=eq\.([^&]+)/);
    if (byId && method === 'GET') {
      const r = rows.find(x => x.id === decodeURIComponent(byId[1]));
      return { ok: true, json: async () => (r ? [full(r)] : []) };
    }
    const lp = url.match(/vtid_ledger\?vtid=eq\.([^&]+)/);
    if (lp && method === 'PATCH') {
      patches.push({ vtid: decodeURIComponent(lp[1]), body: JSON.parse(init.body) });
      return { ok: true, text: async () => '' };
    }
    return { ok: true, json: async () => [], text: async () => '' };
  }) as unknown as typeof fetch;
  return patches;
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE = 'svc-role';
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { global.fetch = ORIGINAL_FETCH; jest.restoreAllMocks(); });

describe('VTID-04636 lineage-aware reconciliation', () => {
  it('leaves the VTID open while the fix-mode child of a reverted parent is still in CI', async () => {
    const patches = mock(
      [{ id: 'parent', status: 'reverted' }, { id: 'child', status: 'ci', parent: 'parent' }],
      [{ vtid: 'VTID-90614', execId: 'parent' }],
    );
    await reconcileAutopilotLinkedSelfHealingVtids();
    expect(patches).toHaveLength(0);
  });

  it('closes success when the parent is self_healed and its child completed (the live VTID-04614 shape)', async () => {
    const patches = mock(
      [{ id: 'parent', status: 'self_healed' }, { id: 'child', status: 'completed', parent: 'parent', pr_url: 'https://github.com/x/y/pull/3736' }],
      [{ vtid: 'VTID-90614', execId: 'parent' }],
    );
    await reconcileAutopilotLinkedSelfHealingVtids();
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual(expect.objectContaining({ status: 'completed', is_terminal: true, terminal_outcome: 'success' }));
    expect(patches[0].body.metadata.pr_url).toBe('https://github.com/x/y/pull/3736');
  });

  it('walks more than one generation and judges by the newest descendant', async () => {
    const patches = mock(
      [
        { id: 'p', status: 'reverted' },
        { id: 'c1', status: 'reverted', parent: 'p', created_at: '2026-09-26T09:00:00Z' },
        { id: 'c2', status: 'failed_escalated', parent: 'c1', created_at: '2026-09-26T09:30:00Z' },
      ],
      [{ vtid: 'VTID-90001', execId: 'p' }],
    );
    await reconcileAutopilotLinkedSelfHealingVtids();
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual(expect.objectContaining({ status: 'failed', terminal_outcome: 'failed' }));
    expect(patches[0].body.metadata.execution_failure_status).toBe('failed_escalated');
  });

  it('a reverted parent with no child still closes failed (unchanged behaviour)', async () => {
    const patches = mock([{ id: 'p', status: 'reverted' }], [{ vtid: 'VTID-90002', execId: 'p' }]);
    await reconcileAutopilotLinkedSelfHealingVtids();
    expect(patches).toHaveLength(1);
    expect(patches[0].body.terminal_outcome).toBe('failed');
  });

  it('never terminalizes on a partial view: a failed child lookup leaves the VTID open', async () => {
    const patches = mock([{ id: 'p', status: 'reverted' }], [{ vtid: 'VTID-90003', execId: 'p' }], { childLookupFails: true });
    await reconcileAutopilotLinkedSelfHealingVtids();
    expect(patches).toHaveLength(0);
  });

  it('does not look for children of an in-flight or completed row', async () => {
    mock([{ id: 'p', status: 'verifying' }], []);
    const tail = await resolveExecutionLineageTail({ id: 'p', status: 'verifying', pr_url: null, pr_number: null, branch: null, metadata: {}, completed_at: null });
    expect(tail?.id).toBe('p');
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(0);
  });
});
