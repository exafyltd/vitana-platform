/**
 * VTID-04525 (Conversation hub B1) — the system snapshot is built from the
 * same code a live session runs, and the per-build event is a state
 * transition, never a heartbeat.
 */
import {
  buildConversationSystemSnapshot,
  getConversationSystemSnapshot,
  _resetConversationSystemSnapshotCache,
  INTROSPECTION_SESSIONS,
  diffConversationSystems,
  fingerprintOf,
  recordConversationSystemSnapshot,
  snapshotEventPayload,
  type ConversationSystemSnapshot,
} from '../../../src/services/conversation/conversation-system-introspection';
import { buildLiveApiTools } from '../../../src/orb/live/tools/live-tool-catalog';
import {
  enforceToolCatalogBudget,
  resolveToolCatalogByteBudgetFor,
} from '../../../src/orb/live/tools/vertex-tool-catalog-budget';
import { classifyOrbTool } from '../../../src/services/orchestrator/tool-catalog';
import { ORB_TOOL_NAMES } from '../../../src/services/orb-tools-shared';
import { defaultProviderRegistry } from '../../../src/services/assistant-continuation/provider-registry';
import {
  WAKE_OPENERS,
  setNewdayOverviewRungEnabled,
  setDayCloseRungEnabled,
} from '../../../src/services/conversation/compute-greeting-decision';
import { EXPLICIT_SELECTION_PROVIDER_TIMEOUT_MS } from '../../../src/services/wake-brief-wiring';

const NOW = new Date('2026-09-25T00:00:00Z');

function names(tools: object[]): string[] {
  const out: string[] = [];
  for (const g of tools as Array<{ function_declarations?: Array<{ name?: string }> }>) {
    for (const d of g.function_declarations ?? []) if (typeof d?.name === 'string') out.push(d.name);
  }
  return out;
}

describe('VTID-04525 B1 — conversation system snapshot', () => {
  let snap: ConversationSystemSnapshot;
  beforeAll(() => {
    snap = buildConversationSystemSnapshot(NOW);
  });

  test('one catalog view per real session shape, counted by the live builder', () => {
    expect(snap.tools.sessions.map((s) => s.key)).toEqual(INTROSPECTION_SESSIONS.map((s) => s.key));
    for (const s of INTROSPECTION_SESSIONS) {
      const live = buildLiveApiTools(s.mode, s.route, s.role, s.surface) as object[];
      const view = snap.tools.sessions.find((v) => v.key === s.key)!;
      expect(view.declared).toBe(names(live).length);
    }
  });

  test('landing-page anonymous sessions declare no tools; a signed-in community session declares many', () => {
    const view = (k: string) => snap.tools.sessions.find((s) => s.key === k)!;
    expect(view('anonymous_landing').declared).toBe(0);
    expect(view('community').declared).toBeGreaterThan(view('anonymous_app_page').declared);
  });

  test('the Nova budget view matches what enforceToolCatalogBudget does to the same catalog (selection off)', () => {
    const community = INTROSPECTION_SESSIONS.find((s) => s.key === 'community')!;
    const catalog = buildLiveApiTools(community.mode, community.route, community.role, community.surface) as object[];
    const direct = enforceToolCatalogBudget(catalog, resolveToolCatalogByteBudgetFor('nova_sonic').budgetBytes);
    const view = snap.tools.sessions.find((s) => s.key === 'community')!.budget.nova_sonic;
    expect(view.trimmed).toBe(direct.trimmed);
    expect(view.declared_after).toBe(direct.declarationsAfter);
    expect(view.dropped).toBe(direct.dropped.length);
    expect(view.reachable_via_find_tool).toBe(false);
  });

  test('every tool carries the classifier result and covers the ORB registry', () => {
    const byName = new Map(snap.tools.items.map((t) => [t.name, t]));
    for (const n of ORB_TOOL_NAMES) expect(byName.has(n)).toBe(true);
    for (const t of snap.tools.items.slice(0, 50)) {
      const c = classifyOrbTool(t.name);
      expect([t.domain, t.tier, t.self, t.source]).toEqual([c.domain, c.tier, c.self, c.source]);
    }
    expect(snap.tools.total).toBe(snap.tools.items.length);
  });

  test('warnings are derived, not hand-kept', () => {
    const w = snap.tools.warnings;
    for (const n of w.unclassified) expect(classifyOrbTool(n).source).toBe('default');
    for (const n of w.declared_nowhere) {
      const t = snap.tools.items.find((x) => x.name === n)!;
      expect(t.in_orb_registry).toBe(true);
      expect(t.declared_on).toEqual([]);
    }
    for (const n of w.trimmed_everywhere) {
      const t = snap.tools.items.find((x) => x.name === n)!;
      expect(t.trimmed_on_nova.sort()).toEqual(t.declared_on.sort());
    }
  });

  test('opening providers come from the live registry, with the timeouts the ranker uses', () => {
    expect(snap.opening.providers.map((p) => p.key)).toEqual(defaultProviderRegistry.list());
    expect(snap.opening.providers.length).toBeGreaterThan(5);
    expect(snap.opening.explicit_selection_timeout_ms).toBe(EXPLICIT_SELECTION_PROVIDER_TIMEOUT_MS);
    expect(snap.opening.providers.find((p) => p.key === 'guided_topic_narration')?.pinned).toBe(true);
  });

  test('every greeting rung is listed, and the two switchable rungs report their switch', () => {
    expect(snap.opening.rungs.map((r) => r.name)).toEqual([...WAKE_OPENERS]);
    setDayCloseRungEnabled(false);
    try {
      const s2 = buildConversationSystemSnapshot(NOW);
      expect(s2.opening.rungs.find((r) => r.name === 'day_close')?.switch).toBe(false);
      expect(s2.fingerprint).not.toBe(snap.fingerprint);
    } finally {
      setDayCloseRungEnabled(true);
      setNewdayOverviewRungEnabled(true);
    }
  });

  test('fingerprint ignores the timestamp and changes with a flag', () => {
    expect(buildConversationSystemSnapshot(new Date('2030-01-01T00:00:00Z')).fingerprint).toBe(snap.fingerprint);
    const prev = process.env.BRAIN_SCORED_OPENING;
    process.env.BRAIN_SCORED_OPENING = prev === 'true' ? 'false' : 'true';
    try {
      expect(buildConversationSystemSnapshot(NOW).fingerprint).not.toBe(snap.fingerprint);
    } finally {
      if (prev === undefined) delete process.env.BRAIN_SCORED_OPENING;
      else process.env.BRAIN_SCORED_OPENING = prev;
    }
  });

  test('fingerprintOf is key-order independent', () => {
    expect(fingerprintOf({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(fingerprintOf({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });

  test('the per-process cache is reused until refresh', () => {
    _resetConversationSystemSnapshotCache();
    let t = 1_000_000;
    const a = getConversationSystemSnapshot({ now: () => t });
    t += 60_000;
    expect(getConversationSystemSnapshot({ now: () => t })).toBe(a);
    expect(getConversationSystemSnapshot({ now: () => t, refresh: true })).not.toBe(a);
    t += 10 * 60_000;
    expect(getConversationSystemSnapshot({ now: () => t }).generated_at).not.toBe(a.generated_at);
    _resetConversationSystemSnapshotCache();
  });
});

describe('VTID-04525 B1 — diff and per-build snapshot event', () => {
  const sys = (tools: string[], providers: string[], flags: Record<string, unknown>) => ({
    tools: { items: tools.map((name) => ({ name })) },
    opening: { providers: providers.map((key) => ({ key })) },
    flags: Object.entries(flags).map(([name, effective]) => ({ name, effective })),
  }) as any;

  test('diff names added/removed tools and providers and changed flags', () => {
    const d = diffConversationSystems(sys(['a', 'b'], ['p1'], { F: true, G: 1 }), sys(['b', 'c'], ['p1', 'p2'], { F: false, G: 1, H: 2 }));
    expect(d).toEqual({ tools_added: ['c'], tools_removed: ['a'], providers_added: ['p2'], providers_removed: [], flags_changed: ['F'] });
  });

  const snap = buildConversationSystemSnapshot(NOW);

  test('unchanged fingerprint → nothing is emitted', async () => {
    const emit = jest.fn();
    const r = await recordConversationSystemSnapshot({
      env: 'staging',
      build: () => snap,
      readLatest: async () => ({ fingerprint: snap.fingerprint, tool_names: [], provider_keys: [], flag_values: {} }),
      emit,
    });
    expect(r).toMatchObject({ recorded: false, reason: 'unchanged' });
    expect(emit).not.toHaveBeenCalled();
  });

  test('first snapshot for a stack is recorded without a diff', async () => {
    const emit = jest.fn().mockResolvedValue({ ok: true });
    const r = await recordConversationSystemSnapshot({ env: 'staging', build: () => snap, readLatest: async () => null, emit });
    expect(r).toMatchObject({ recorded: true, reason: 'first' });
    expect(emit.mock.calls[0][0]).toMatchObject({ fingerprint: snap.fingerprint, env: 'staging', diff: null });
  });

  test('a changed build is recorded with its diff against the previous one', async () => {
    const emit = jest.fn().mockResolvedValue({ ok: true });
    const prevTools = snap.tools.items.map((t) => t.name).slice(1);
    const r = await recordConversationSystemSnapshot({
      env: 'production',
      build: () => snap,
      readLatest: async () => ({ fingerprint: 'old', tool_names: [...prevTools, 'retired_tool'], provider_keys: snap.opening.providers.map((p) => p.key), flag_values: {} }),
      emit,
    });
    expect(r).toMatchObject({ recorded: true, reason: 'changed' });
    const payload = emit.mock.calls[0][0];
    expect(payload.diff.tools_added).toEqual([snap.tools.items[0].name]);
    expect(payload.diff.tools_removed).toEqual(['retired_tool']);
  });

  test('an emit failure or a throw is reported, never thrown', async () => {
    const failed = await recordConversationSystemSnapshot({ env: 'staging', build: () => snap, readLatest: async () => null, emit: async () => ({ ok: false, error: 'boom' }) });
    expect(failed).toMatchObject({ recorded: false, reason: 'emit_failed: boom' });
    const thrown = await recordConversationSystemSnapshot({ env: 'staging', build: () => { throw new Error('bad'); }, readLatest: async () => null, emit: jest.fn() });
    expect(thrown).toMatchObject({ recorded: false, reason: 'error: bad' });
  });

  test('the event payload carries names and effective values only, never instruction text', () => {
    const p = snapshotEventPayload(snap, 'staging', null);
    expect(Object.keys(p).sort()).toEqual(['commit', 'counts', 'diff', 'env', 'fingerprint', 'flag_values', 'provider_keys', 'tool_names']);
    expect(JSON.stringify(p).length).toBeLessThan(60_000);
  });
});
