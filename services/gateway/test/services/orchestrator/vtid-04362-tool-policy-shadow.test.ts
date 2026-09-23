/**
 * VTID-04362 — Orchestrator v2 P2 shadow on real ORB tool calls
 * (docs/ORCHESTRATOR-REDESIGN-PLAN.md §3.2, §5 P2).
 *
 * AC-1 every name in ORB_TOOL_NAMES classifies without falling through to the
 *      default rule, so a new tool must be classified on purpose.
 * AC-2 high is an explicit list; dev_/admin_ tools land in their domains;
 *      user-own low-risk commits are marked self.
 * AC-3 evaluateToolCall: voice may commit a self tool when the role may
 *      commit; every other voice commit escalates; high escalates/denies.
 * AC-4 the shadow recorder aggregates, keeps only non-allow decisions in the
 *      recent ring, stays bounded and never throws.
 * AC-5 dispatchOrbTool records a decision and still runs the handler — the
 *      shadow never blocks.
 */

import { ORB_TOOL_NAMES, ORB_TOOL_REGISTRY, dispatchOrbTool } from '../../../src/services/orb-tools-shared';
import { buildToolCatalog, classifyOrbTool, summarizeCatalog } from '../../../src/services/orchestrator/tool-catalog';
import { evaluateToolCall } from '../../../src/services/orchestrator/policy';
import {
  MAX_AGGREGATE_KEYS,
  RECENT_LIMIT,
  recordToolDecision,
  resetShadow,
  shadowSnapshot,
} from '../../../src/services/orchestrator/policy-shadow';

beforeEach(() => resetShadow());

describe('tool catalog (AC-1, AC-2)', () => {
  test('every ORB tool classifies without the default rule', () => {
    expect(ORB_TOOL_NAMES.length).toBeGreaterThan(100);
    const catalog = buildToolCatalog(ORB_TOOL_NAMES);
    const unclassified = Object.entries(catalog).filter(([, c]) => c.source === 'default').map(([n]) => n);
    expect(unclassified).toEqual([]);
  });

  test('domains follow the prefix; high is explicit', () => {
    expect(classifyOrbTool('dev_publish_to_prod')).toMatchObject({ domain: 'dev', tier: 'high' });
    expect(classifyOrbTool('admin_grant_role')).toMatchObject({ domain: 'admin', tier: 'high' });
    expect(classifyOrbTool('dev_recent_events')).toMatchObject({ domain: 'dev', tier: 'read' });
    expect(classifyOrbTool('log_water')).toMatchObject({ domain: 'health', tier: 'commit', self: true });
    expect(classifyOrbTool('set_alarm')).toMatchObject({ domain: 'community', tier: 'commit', self: true });
    expect(classifyOrbTool('create_service')).toMatchObject({ domain: 'professional', tier: 'commit', self: false });
    expect(classifyOrbTool('admin_update_proposal_status')).toMatchObject({ tier: 'commit' });
    expect(classifyOrbTool('admin_compose_broadcast')).toMatchObject({ tier: 'draft' });
    // No verb anywhere may produce 'high' by inference.
    expect(classifyOrbTool('dev_revert_something_new').tier).not.toBe('high');
  });

  test('summary counts every tool once', () => {
    const summary = summarizeCatalog(buildToolCatalog(ORB_TOOL_NAMES));
    const total = Object.values(summary).reduce((n, t) => n + Object.values(t).reduce((a, b) => a + b, 0), 0);
    expect(total).toBe(ORB_TOOL_NAMES.length);
  });
});

describe('evaluateToolCall (AC-3)', () => {
  const voice = (role: string) => ({ platform_role: role, orgs: [], channel: 'voice' as const });

  test('a self commit is allowed by voice when the role may commit', () => {
    const d = evaluateToolCall(voice('community'), classifyOrbTool('log_water'));
    expect(d.decision).toBe('allow');
  });

  test('a non-self commit by voice escalates to chat/web', () => {
    expect(classifyOrbTool('send_chat_message')).toMatchObject({ domain: 'community', tier: 'commit', self: false });
    const d = evaluateToolCall(voice('community'), classifyOrbTool('send_chat_message'));
    expect(d.decision).toBe('escalate');
  });

  test('professional defaults stop at draft, so create_service is a shadow deny (finding for review)', () => {
    expect(evaluateToolCall(voice('professional'), classifyOrbTool('create_service')).decision).toBe('deny');
  });

  test('a community member cannot touch dev tools; a developer read is allowed', () => {
    expect(evaluateToolCall(voice('community'), classifyOrbTool('dev_recent_events')).decision).toBe('deny');
    expect(evaluateToolCall(voice('developer'), classifyOrbTool('dev_recent_events')).decision).toBe('allow');
  });

  test('high risk queues for maker-checker, never allows directly', () => {
    expect(evaluateToolCall(voice('developer'), classifyOrbTool('dev_publish_to_prod')).decision).toBe('escalate');
    expect(evaluateToolCall(voice('community'), classifyOrbTool('dev_publish_to_prod')).decision).toBe('deny');
  });

  test('anonymous may only read community', () => {
    expect(evaluateToolCall(voice('anonymous'), classifyOrbTool('search_events')).decision).toBe('allow');
    expect(evaluateToolCall(voice('anonymous'), classifyOrbTool('log_water')).decision).toBe('deny');
  });
});

describe('shadow recorder (AC-4)', () => {
  test('aggregates by role|tool|decision and rings only non-allow', () => {
    recordToolDecision({ tool: 'log_water', role: 'community' });
    recordToolDecision({ tool: 'log_water', role: 'community' });
    recordToolDecision({ tool: 'dev_recent_events', role: 'community', session_id: 's1' });
    const snap = shadowSnapshot();
    expect(snap.enforced).toBe(false);
    expect(snap.total_calls).toBe(3);
    expect(snap.by_decision).toEqual({ allow: 2, escalate: 0, deny: 1 });
    expect(snap.aggregates[0]).toMatchObject({ tool: 'dev_recent_events', decision: 'deny', count: 1 });
    expect(snap.recent_non_allow).toHaveLength(1);
    expect(snap.recent_non_allow[0]).toMatchObject({ tool: 'dev_recent_events', session_id: 's1' });
  });

  test('a null role is recorded as anonymous', () => {
    recordToolDecision({ tool: 'search_events', role: null });
    expect(shadowSnapshot().aggregates[0]).toMatchObject({ role: 'anonymous', decision: 'allow' });
  });

  test('stays bounded', () => {
    for (let i = 0; i < MAX_AGGREGATE_KEYS + 10; i++) recordToolDecision({ tool: `dev_x_${i}`, role: 'community' });
    const snap = shadowSnapshot();
    expect(snap.aggregates).toHaveLength(MAX_AGGREGATE_KEYS);
    expect(snap.dropped_keys).toBe(10);
    expect(snap.recent_non_allow.length).toBeLessThanOrEqual(RECENT_LIMIT);
  });

  test('never throws on bad input', () => {
    expect(() => recordToolDecision({ tool: undefined as any, role: {} as any })).not.toThrow();
  });
});

describe('dispatchOrbTool wiring (AC-5)', () => {
  test('records a decision and still runs the handler — the shadow never blocks', async () => {
    // A community member calling a dev tool is a shadow `deny`; the call must
    // still reach the handler (which fails on its own terms, not the policy's).
    const original = ORB_TOOL_REGISTRY.dev_recent_events;
    const handler = jest.fn(async () => ({ ok: true, result: { stubbed: true } }));
    ORB_TOOL_REGISTRY.dev_recent_events = handler as any;
    try {
      const res = await dispatchOrbTool('dev_recent_events', {}, { user_id: 'u', tenant_id: 't', role: 'community' } as any, {} as any);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(res).toMatchObject({ ok: true, result: { stubbed: true } });
    } finally {
      ORB_TOOL_REGISTRY.dev_recent_events = original;
    }
    const snap = shadowSnapshot();
    expect(snap.total_calls).toBe(1);
    expect(snap.aggregates[0]).toMatchObject({ role: 'community', tool: 'dev_recent_events', decision: 'deny' });
  });

  test('an unknown tool is not recorded', async () => {
    await dispatchOrbTool('no_such_tool', {}, { user_id: 'u', tenant_id: 't', role: 'community' } as any, {} as any);
    expect(shadowSnapshot().total_calls).toBe(0);
  });
});
