/**
 * VTID-04784: memory plan phase 2 — the served ORB memory read is compared
 * with the other read path in the background, counts only, read-only.
 */
const mockRecall = jest.fn();
jest.mock('../../../src/services/memory/recall', () => ({
  isOrbRecallEnabled: () => process.env.MEMORY_ORB_RECALL_ENABLED === 'true',
  recallOrbMemoryItems: (...a: any[]) => mockRecall(...a),
}));

import {
  compareMemoryContexts,
  formatShadowLine,
  runRecallShadow,
  isRecallShadowEnabled,
} from '../../../src/services/memory/recall-shadow';
import { fetchMemoryContextWithIdentity } from '../../../src/services/orb-memory-bridge';

const fact = (id: string, key: string, value: string) => ({ id, source: 'memory_facts', content_json: { fact_key: key, fact_value: value } });

describe('VTID-04784 compareMemoryContexts', () => {
  const served = {
    ok: true,
    formatted_context: 'x'.repeat(100),
    items: [
      fact('1', 'spouse_name', 'Maria Maksina'),
      fact('2', 'father_name', 'Marco'),
      fact('3', 'mother_name', 'Mariana'),
      { id: 'a', source: 'ai_memory' },
      { id: 'e', source: 'session_summary' },
    ],
  };
  const shadow = {
    ok: true,
    formatted_context: 'y'.repeat(80),
    items: [
      fact('1', 'spouse_name', 'Maria Maksina'),
      fact('3', 'mother_name', 'Mirjana'),
      fact('4', 'spouse_father_name', 'Viktor'),
      { id: 'e', source: 'session_summary' },
      { id: 'd', source: 'diary' },
    ],
  };

  it('counts shared, one-sided and differing facts', () => {
    const c = compareMemoryContexts(served, shadow, { served: 'legacy', ms_served: 200, ms_shadow: 90 });
    expect(c).toMatchObject({
      served: 'legacy', shadow: 'recall',
      facts_served: 3, facts_shadow: 3,
      facts_only_served: 1, facts_only_shadow: 1, facts_value_diff: 1,
      ai_memory_served: 1, ai_memory_shadow: 0,
      other_served: 1, other_shadow: 2,
      chars_served: 100, chars_shadow: 80,
      ms_served: 200, ms_shadow: 90, shadow_ok: true,
    });
  });

  it('identical contexts compare as identical', () => {
    const c = compareMemoryContexts(served, served, { served: 'recall', ms_served: 1, ms_shadow: 1 });
    expect(c.shadow).toBe('legacy');
    expect(c.facts_only_served + c.facts_only_shadow + c.facts_value_diff).toBe(0);
  });

  it('the log line carries counts only, never a key, value or member text', () => {
    const line = formatShadowLine(compareMemoryContexts(served, shadow, { served: 'legacy', ms_served: 1, ms_shadow: 1 }));
    expect(line).toMatch(/^\[VTID-04784\] recall-shadow served=legacy shadow=recall ok=true facts=3\/3 only_served=1 only_shadow=1 value_diff=1 /);
    for (const secret of ['Maria', 'Marco', 'Mirjana', 'Viktor', 'spouse', 'father', 'mother']) {
      expect(line).not.toContain(secret);
    }
  });
});

describe('VTID-04784 runRecallShadow', () => {
  const served = { ok: true, items: [], formatted_context: '' };

  it('logs the comparison', async () => {
    const lines: string[] = [];
    await runRecallShadow(served, { served: 'legacy', ms_served: 5 }, async () => served, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('served=legacy shadow=recall ok=true');
  });

  it('never rejects when the other read throws', async () => {
    const lines: string[] = [];
    await expect(
      runRecallShadow(served, { served: 'recall', ms_served: 5 }, async () => { throw new Error('boom'); }, (l) => lines.push(l)),
    ).resolves.toBeUndefined();
    expect(lines[0]).toBe('[VTID-04784] recall-shadow served=recall failed: boom');
  });

  it('is on only for the exact string true', () => {
    const before = process.env.MEMORY_ORB_RECALL_SHADOW;
    for (const v of ['1', 'yes', 'TRUE', '']) {
      process.env.MEMORY_ORB_RECALL_SHADOW = v;
      expect(isRecallShadowEnabled()).toBe(false);
    }
    process.env.MEMORY_ORB_RECALL_SHADOW = 'true';
    expect(isRecallShadowEnabled()).toBe(true);
    if (before === undefined) delete process.env.MEMORY_ORB_RECALL_SHADOW; else process.env.MEMORY_ORB_RECALL_SHADOW = before;
  });
});

describe('VTID-04784 fetchMemoryContextWithIdentity shadow wiring', () => {
  const ID = { user_id: '11111111-1111-1111-1111-111111111111', tenant_id: '22222222-2222-2222-2222-222222222222' };
  const T = new Date().toISOString();
  const env = { ...process.env };
  const flush = () => new Promise((r) => setTimeout(r, 20));
  let logs: string[];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    mockRecall.mockReset();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    logs = [];
    spy = jest.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.join(' ')); });
  });
  afterEach(() => { spy.mockRestore(); process.env = { ...env }; });

  const recallOk = () => mockRecall.mockResolvedValue({
    ok: true, latency_ms: 5, degraded: false, sections: { facts: 1, episodes: 0, diary: 0 },
    items: [{ id: 'f1', category_key: 'personal', source: 'memory_facts', content: 'child_name: Mia', content_json: { fact_key: 'child_name', fact_value: 'Mia' }, importance: 95, occurred_at: T, created_at: T }],
  });

  it('shadow off: no second read, no shadow line', async () => {
    process.env.MEMORY_ORB_RECALL_ENABLED = 'true';
    delete process.env.MEMORY_ORB_RECALL_SHADOW;
    recallOk();
    const r = await fetchMemoryContextWithIdentity(ID);
    await flush();
    expect(r.read_path).toBe('recall');
    expect(mockRecall).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes('recall-shadow'))).toBe(false);
  });

  it('serving recall, the legacy read runs as the shadow and the answer is unchanged', async () => {
    process.env.MEMORY_ORB_RECALL_ENABLED = 'true';
    process.env.MEMORY_ORB_RECALL_SHADOW = 'true';
    recallOk();
    const r = await fetchMemoryContextWithIdentity(ID);
    expect(r.ok).toBe(true);
    expect(r.read_path).toBe('recall');
    expect(r.formatted_context).toContain('Mia');
    await flush();
    expect(mockRecall).toHaveBeenCalledTimes(1);
    // No Supabase in the test: the legacy shadow read is not ok, and says so.
    const line = logs.find((l) => l.includes('[VTID-04784] recall-shadow'));
    expect(line).toContain('served=recall shadow=legacy ok=false');
    expect(line).not.toContain('Mia');
  });

  it('a failed served read starts no shadow', async () => {
    delete process.env.MEMORY_ORB_RECALL_ENABLED;
    process.env.MEMORY_ORB_RECALL_SHADOW = 'true';
    const r = await fetchMemoryContextWithIdentity(ID);
    await flush();
    expect(r.ok).toBe(false);
    expect(mockRecall).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('recall-shadow'))).toBe(false);
  });

  it('the dev sandbox (no identity) never shadows', async () => {
    process.env.MEMORY_ORB_RECALL_SHADOW = 'true';
    await fetchMemoryContextWithIdentity(null);
    await flush();
    expect(logs.some((l) => l.includes('recall-shadow'))).toBe(false);
  });
});
