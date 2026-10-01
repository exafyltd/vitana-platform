/**
 * VTID-04493 (Community Autopilot CA-1): get/activate_autopilot_recommendations
 * on the shared ORB tool registry, so every voice transport has them and the
 * "what Vitana just read out" memory lives in orb_session_state.
 */
process.env.NODE_ENV = 'test';

jest.mock('../src/routes/autopilot-recommendations', () => ({
  activateCommunityAutopilotRecommendation: jest.fn(),
  listCommunityAutopilotRecommendations: jest.fn(),
  summarizeAutopilotForVoice: (recs: Array<{ id: string; title: string }>) => ({
    spoken: `${recs.length} items`,
    ids: recs.map((r) => r.id),
    count: recs.length,
  }),
}));

import {
  activateCommunityAutopilotRecommendation,
  listCommunityAutopilotRecommendations,
} from '../src/routes/autopilot-recommendations';
import { ORB_TOOL_REGISTRY } from '../src/services/orb-tools-shared';
import {
  MAX_ACTIVATE_PER_CALL,
  tool_activate_autopilot_recommendations,
  tool_get_autopilot_recommendations,
} from '../src/services/orb-tools/community-autopilot-tools';
import { classifyOrbTool } from '../src/services/orchestrator/tool-catalog';

const activate = activateCommunityAutopilotRecommendation as jest.Mock;
const list = listCommunityAutopilotRecommendations as jest.Mock;

const USER = 'aaaa1111-1111-4111-8111-111111111111';
const IDENT = { user_id: USER, tenant_id: 'tenant-1', role: 'community' };

/** In-memory orb_session_state keyed by (user_id, key). */
function memSb() {
  const rows = new Map<string, { value: unknown; expires_at: string }>();
  const k = (u: string, key: string) => `${u}:${key}`;
  const sb = {
    rows,
    from(table: string) {
      if (table !== 'orb_session_state') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: (_c: string, u: string) => ({
            eq: (_c2: string, key: string) => ({
              maybeSingle: async () => ({ data: rows.get(k(u, key)) ?? null, error: null }),
            }),
          }),
        }),
        upsert: async (row: { user_id: string; key: string; value: unknown; expires_at: string }) => {
          rows.set(k(row.user_id, row.key), { value: row.value, expires_at: row.expires_at });
          return { error: null };
        },
        delete: () => ({
          eq: (_c: string, u: string) => ({
            eq: async (_c2: string, key: string) => {
              rows.delete(k(u, key));
              return { error: null };
            },
          }),
        }),
      };
    },
  };
  return sb;
}

beforeEach(() => {
  activate.mockReset();
  list.mockReset();
  activate.mockImplementation(async (_u: string, id: string) => ({
    ok: true,
    httpStatus: 200,
    title: `T-${id}`,
    calendar_event_id: `ev-${id}`,
  }));
});

describe('registry', () => {
  test('AC-1: both tools are on the shared registry (every transport)', () => {
    expect(typeof ORB_TOOL_REGISTRY.get_autopilot_recommendations).toBe('function');
    expect(typeof ORB_TOOL_REGISTRY.activate_autopilot_recommendations).toBe('function');
    expect(typeof ORB_TOOL_REGISTRY.activate_recommendation).toBe('function');
  });

  test('policy: activation of the member\'s own item is a self commit (voice may confirm it)', () => {
    for (const name of ['activate_recommendation', 'activate_autopilot_recommendations']) {
      expect(classifyOrbTool(name)).toMatchObject({ domain: 'community', tier: 'commit', self: true });
    }
    expect(classifyOrbTool('get_autopilot_recommendations').tier).toBe('read');
  });
});

describe('get → activate', () => {
  test('AC-2: listing stores the read-out ids; activating with no args runs exactly those', async () => {
    const sb = memSb();
    list.mockResolvedValue([
      { id: 'r1', title: 'Walk' },
      { id: 'r2', title: 'Water' },
    ]);
    const g = await tool_get_autopilot_recommendations({ limit: 5 }, IDENT, sb as never);
    expect(g.ok).toBe(true);
    expect(list).toHaveBeenCalledWith(USER, 5, { autoGenerate: true });
    if (g.ok === true) {
      expect(g.result).toMatchObject({ count: 2, items: [{ position: 1, id: 'r1' }, { position: 2, id: 'r2' }] });
    }

    const a = await tool_activate_autopilot_recommendations({}, IDENT, sb as never);
    expect(a.ok).toBe(true);
    expect(activate.mock.calls.map((c) => c[1])).toEqual(['r1', 'r2']);
    expect(activate).toHaveBeenCalledWith(USER, 'r1', { tenantId: 'tenant-1', skipReplenish: true, channel: 'voice', confirmed: false });
    if (a.ok === true) expect(a.result).toMatchObject({ activated: 2, failed: 0 });
    // The used list is cleared so a stray repeat call can't re-activate.
    expect(sb.rows.size).toBe(0);
  });

  test('AC-3: "the second one" resolves by position against the read-out list', async () => {
    const sb = memSb();
    list.mockResolvedValue([{ id: 'r1', title: 'A' }, { id: 'r2', title: 'B' }, { id: 'r3', title: 'C' }]);
    await tool_get_autopilot_recommendations({}, IDENT, sb as never);
    const a = await tool_activate_autopilot_recommendations({ positions: [2] }, IDENT, sb as never);
    expect(a.ok).toBe(true);
    expect(activate.mock.calls.map((c) => c[1])).toEqual(['r2']);
  });

  test('explicit ids win, are de-duplicated and capped', async () => {
    const sb = memSb();
    const ids = ['x1', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7'];
    await tool_activate_autopilot_recommendations({ ids }, IDENT, sb as never);
    expect(activate).toHaveBeenCalledTimes(MAX_ACTIVATE_PER_CALL);
    expect(activate.mock.calls[0][1]).toBe('x1');
  });

  test('nothing listed → no activation, a pointer to list first', async () => {
    const a = await tool_activate_autopilot_recommendations({}, IDENT, memSb() as never);
    expect(a.ok).toBe(true);
    expect(activate).not.toHaveBeenCalled();
    if (a.ok === true) expect(a.result).toMatchObject({ activated: 0, nothing_listed: true });
  });

  test('a per-item failure is reported, the rest still activate', async () => {
    activate.mockImplementation(async (_u: string, id: string) =>
      id === 'bad'
        ? { ok: false, httpStatus: 403, error: 'Recommendation belongs to another user' }
        : { ok: true, httpStatus: 200, title: `T-${id}` },
    );
    const a = await tool_activate_autopilot_recommendations({ ids: ['ok1', 'bad'] }, IDENT, memSb() as never);
    expect(a.ok).toBe(true);
    if (a.ok === true) {
      expect(a.result).toMatchObject({ activated: 1, failed: 1 });
      const items = (a.result as { items: Array<{ id: string; error: string | null }> }).items;
      expect(items.find((i) => i.id === 'bad')?.error).toBe('recommendation_belongs_to_another_user');
    }
  });

  test('anonymous callers are refused on both tools', async () => {
    const anon = { ...IDENT, user_id: '' };
    const g = await tool_get_autopilot_recommendations({}, anon, memSb() as never);
    const a = await tool_activate_autopilot_recommendations({ ids: ['r1'] }, anon, memSb() as never);
    expect(g.ok).toBe(false);
    expect(a.ok).toBe(false);
    expect(list).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });
});
