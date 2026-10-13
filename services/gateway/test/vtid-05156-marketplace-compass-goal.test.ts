/**
 * VTID-05156 (Health Hub Phase 0 fix-ups, Defect 3) — find_perfect_product /
 * find_perfect_practitioner read the member's real Life Compass goal.
 *
 * `_getCompassGoal` used to select `life_compass.current_goal`, a column that
 * does not exist. PostgREST answers an unknown column with an error object
 * (42703), the code ignored it, and `compass_goal` was always null — the
 * "read only the member's Life Compass goal" promise of VTID-05089 read
 * nothing. It now uses the same corrected query as tool_get_life_compass
 * (VTID-03022): `primary_goal`, `is_active = true`, newest first, one row,
 * and a returned error is logged instead of swallowed.
 *
 * Every database read is a recording fake; nothing touches a real database.
 */

jest.mock('../src/lib/supabase', () => ({ getSupabase: jest.fn(() => ({})) }));

import { tool_find_perfect_product, tool_find_perfect_practitioner } from '../src/services/orb-tools-shared';

type Step = { method: string; args: unknown[] };
type LcResp = { data: unknown; error: { code?: string; message: string } | null };

function recordingClient(lifeCompass: LcResp) {
  const calls: Array<{ table: string; steps: Step[] }> = [];
  const client: any = {
    from: jest.fn((table: string) => {
      const steps: Step[] = [];
      calls.push({ table, steps });
      const chain: any = {};
      for (const m of ['select', 'eq', 'limit', 'order', 'contains', 'lte', 'ilike', 'in']) {
        chain[m] = jest.fn((...args: unknown[]) => (steps.push({ method: m, args }), chain));
      }
      const resp = () =>
        table === 'life_compass'
          ? lifeCompass
          : { data: [{ name: 'Magnesium', display_name: 'Dr. Rest', ingredients: [] }], error: null };
      chain.maybeSingle = jest.fn(() => Promise.resolve(resp()));
      chain.then = (res: any, rej: any) => Promise.resolve(resp()).then(res, rej);
      return chain;
    }),
    rpc: jest.fn(),
  };
  return { client, calls };
}

const ID = { user_id: 'u1', tenant_id: 't1', role: 'community', vitana_id: null } as never;

const TOOLS: Array<[string, (args: any, id: any, sb: any) => Promise<any>, Record<string, unknown>]> = [
  ['find_perfect_product', tool_find_perfect_product, { goal_text: 'better sleep' }],
  ['find_perfect_practitioner', tool_find_perfect_practitioner, { specialty: 'sleep' }],
];

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe.each(TOOLS)('%s — Life Compass goal (VTID-05156)', (name, tool, args) => {
  it('selects primary_goal from the active row, newest first — never current_goal', async () => {
    const { client, calls } = recordingClient({ data: { primary_goal: 'Sleep 8 hours' }, error: null });
    await tool(args, ID, client);
    const lc = calls.find((c) => c.table === 'life_compass');
    expect(lc).toBeDefined();
    expect(lc!.steps).toContainEqual({ method: 'select', args: ['primary_goal'] });
    expect(lc!.steps).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
    expect(lc!.steps).toContainEqual({ method: 'eq', args: ['is_active', true] });
    expect(lc!.steps).toContainEqual({ method: 'order', args: ['created_at', { ascending: false }] });
    expect(lc!.steps).toContainEqual({ method: 'limit', args: [1] });
    expect(JSON.stringify(lc!.steps)).not.toContain('current_goal');
  });

  it('an active goal appears in compass_goal and the rationale', async () => {
    const { client } = recordingClient({ data: { primary_goal: '  Sleep 8 hours ' }, error: null });
    const r = await tool(args, ID, client);
    expect(r.ok).toBe(true);
    expect(r.result.compass_goal).toBe('Sleep 8 hours');
    expect(r.result.rationale).toContain('Sleep 8 hours');
    expect(r.text).toContain('Sleep 8 hours');
    expect(warn).not.toHaveBeenCalled();
  });

  it('no active goal → compass_goal null, no warning', async () => {
    const { client } = recordingClient({ data: null, error: null });
    const r = await tool(args, ID, client);
    expect(r.ok).toBe(true);
    expect(r.result.compass_goal).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a returned PostgREST error → compass_goal null, one warning, results still returned', async () => {
    const { client } = recordingClient({
      data: null,
      error: { code: '42703', message: 'column life_compass.x does not exist' },
    });
    const r = await tool(args, ID, client);
    expect(r.ok).toBe(true);
    expect(r.result.compass_goal).toBeNull();
    expect(r.result.results.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toBe(`[${name}] life_compass read failed: 42703`);
  });
});
