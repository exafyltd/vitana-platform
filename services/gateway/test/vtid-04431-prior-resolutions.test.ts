/**
 * VTID-04431 — similar resolved tickets inform the drafters.
 */
import {
  findSimilarResolvedTickets,
  renderPriorResolutions,
  isPriorResolutionsEnabled,
  PRIOR_RESOLUTIONS_LIMIT,
} from '../src/services/memory/support-ticket';

const mockCallViaRouter = jest.fn();
jest.mock('../src/services/llm-router', () => ({ callViaRouter: (...a: unknown[]) => mockCallViaRouter(...a) }));

type Row = Record<string, unknown>;

/** Minimal Supabase stand-in: feedback_tickets / user_tenants reads and one RPC. */
function fakeSb(opts: {
  tickets: Row[];
  tenants?: Row[];
  hits?: Array<{ ticket_id: string; similarity: number }>;
  rpcError?: string;
}) {
  const rpc = jest.fn(async () => (opts.rpcError ? { data: null, error: { message: opts.rpcError } } : { data: opts.hits ?? [], error: null }));
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let rows: Row[] = table === 'feedback_tickets' ? opts.tickets : table === 'user_tenants' ? (opts.tenants ?? []) : [];
    const q: any = {
      select: () => q,
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
      in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return q; },
      order: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown) => res({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }),
    };
    return q;
  };
  return { sb: { from, rpc } as any, rpc };
}

const T = 'tttttttt-0000-0000-0000-000000000001';
const baseTickets: Row[] = [
  { id: 'cur', user_id: 'u1', ticket_number: 'FB-2026-09-000010', kind: 'bug', status: 'new' },
  { id: 'old1', user_id: 'u2', ticket_number: 'FB-2026-08-000003', kind: 'bug', status: 'resolved', resolution_md: '**Fixed** by clearing the cached session.', draft_answer_md: null, raw_transcript: 'my name is Anna and login fails' },
  { id: 'old2', user_id: 'u3', ticket_number: 'FB-2026-08-000004', kind: 'support_question', status: 'user_confirmed', resolution_md: null, draft_answer_md: 'Open Settings > Language.' },
  { id: 'open', user_id: 'u4', ticket_number: 'FB-2026-08-000005', kind: 'bug', status: 'in_progress', resolution_md: 'draft only' },
];
const embed = jest.fn(async () => ({ ok: true, embedding: [0.1, 0.2] }));

describe('VTID-04431 findSimilarResolvedTickets', () => {
  beforeEach(() => { embed.mockClear(); });

  it('returns resolutions of resolved tickets, best match first, tenant-scoped, excluding the ticket itself', async () => {
    const { sb, rpc } = fakeSb({
      tickets: baseTickets,
      tenants: [{ user_id: 'u1', tenant_id: T }],
      hits: [{ ticket_id: 'old2', similarity: 0.6 }, { ticket_id: 'old1', similarity: 0.8 }, { ticket_id: 'open', similarity: 0.9 }],
    });
    const out = await findSimilarResolvedTickets('cur', 'login keeps failing', { sb, embed });
    expect(rpc).toHaveBeenCalledWith('support_resolution_search', expect.objectContaining({
      p_tenant_id: T, p_exclude_ticket_id: 'cur', p_top_k: PRIOR_RESOLUTIONS_LIMIT,
    }));
    expect(out.map((p) => p.ticket_number)).toEqual(['FB-2026-08-000003', 'FB-2026-08-000004']);
    expect(out[0].resolution).toBe('Fixed by clearing the cached session.');
    expect(out[1].resolution).toBe('Open Settings Language.');
  });

  it('never carries another member\'s report text', async () => {
    const { sb } = fakeSb({ tickets: baseTickets, tenants: [{ user_id: 'u1', tenant_id: T }], hits: [{ ticket_id: 'old1', similarity: 0.8 }] });
    const out = await findSimilarResolvedTickets('cur', 'login', { sb, embed });
    expect(JSON.stringify(out)).not.toMatch(/Anna/);
  });

  it('returns [] when the flag is off, without any read', async () => {
    const { sb, rpc } = fakeSb({ tickets: baseTickets });
    expect(isPriorResolutionsEnabled({ SUPPORT_PRIOR_RESOLUTIONS_ENABLED: 'false' } as any)).toBe(false);
    const out = await findSimilarResolvedTickets('cur', 'x', { sb, embed, env: { SUPPORT_PRIOR_RESOLUTIONS_ENABLED: 'false' } as any });
    expect(out).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it('returns [] with no tenant, a failed embedding, or an RPC error', async () => {
    const noTenant = fakeSb({ tickets: baseTickets, tenants: [] });
    expect(await findSimilarResolvedTickets('cur', 'x', { sb: noTenant.sb, embed })).toEqual([]);
    expect(noTenant.rpc).not.toHaveBeenCalled();

    const ok = fakeSb({ tickets: baseTickets, tenants: [{ user_id: 'u1', tenant_id: T }] });
    expect(await findSimilarResolvedTickets('cur', 'x', { sb: ok.sb, embed: async () => ({ ok: false }) })).toEqual([]);

    const err = fakeSb({ tickets: baseTickets, tenants: [{ user_id: 'u1', tenant_id: T }], rpcError: 'boom' });
    expect(await findSimilarResolvedTickets('cur', 'x', { sb: err.sb, embed })).toEqual([]);
  });

  it('returns [] for empty text or no supabase', async () => {
    expect(await findSimilarResolvedTickets('cur', '  ', { sb: fakeSb({ tickets: baseTickets }).sb, embed })).toEqual([]);
    expect(await findSimilarResolvedTickets('cur', 'x', { sb: null, embed })).toEqual([]);
  });
});

describe('VTID-04431 renderPriorResolutions', () => {
  it('is empty with nothing to show', () => {
    expect(renderPriorResolutions([])).toBe('');
  });
  it('renders reference-only guidance and one line per ticket', () => {
    const s = renderPriorResolutions([{ ticket_number: 'FB-1', kind: 'bug', resolution: 'cleared cache', similarity: 0.7 }]);
    expect(s).toMatch(/reference only/);
    expect(s).toMatch(/do not mention other tickets or other members/i);
    expect(s).toContain('- FB-1 (bug): cleared cache');
  });
});

describe('VTID-04431 drafters include prior resolutions', () => {
  const ticket = {
    id: 'cur', ticket_number: 'FB-2026-09-000010', kind: 'support_question', raw_transcript: 'how do I change language',
    intake_messages: null, structured_fields: null, classifier_meta: null, screen_path: null, app_version: null, vitana_id: null, priority: null,
  };
  beforeEach(() => { mockCallViaRouter.mockReset(); mockCallViaRouter.mockResolvedValue({ ok: true, text: 'answer' }); });

  it('Sage, Devon and Mira prompts carry the block', async () => {
    const r = await import('../src/services/feedback-llm-resolvers');
    const prior = [{ ticket_number: 'FB-9', kind: 'support_question', resolution: 'Settings > Language', similarity: 0.8 }];
    await r.llmDraftSageAnswer(ticket as any, { priorResolutions: prior });
    await r.llmDraftDevonSpec(ticket as any, { priorResolutions: prior });
    await r.llmDraftMiraResolution(ticket as any, { priorResolutions: prior });
    expect(mockCallViaRouter).toHaveBeenCalledTimes(3);
    for (const call of mockCallViaRouter.mock.calls) {
      expect(call[1]).toContain('HOW SIMILAR TICKETS WERE RESOLVED BEFORE');
      expect(call[1]).toContain('- FB-9 (support_question): Settings > Language');
    }
  });

  it('an empty list leaves the prompt unchanged', async () => {
    const r = await import('../src/services/feedback-llm-resolvers');
    await r.llmDraftSageAnswer(ticket as any, { priorResolutions: [] });
    expect(mockCallViaRouter.mock.calls[0][1]).not.toContain('HOW SIMILAR TICKETS');
  });
});
