/**
 * VTID-04667 (P4.1): per-scanner / per-rule circuit breaker.
 *
 * Live, 30 days: 74 scanner executions, 0 completed. The breaker opens a
 * scanner once >= 5 of its last 10 decided executions exist and < 20 % of
 * them landed; outage-class failures, cancellations and rejections never
 * count. One OASIS event per transition.
 */
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async () => ({ ok: true })),
}));

import { emitOasisEvent } from '../src/services/oasis-event-service';
import {
  breakerKeyFor,
  classifyExecution,
  computeBreakerStates,
  resolveBreakerThresholds,
  loadScannerBreakers,
  resetScannerBreakerCache,
  isFindingBreakerOpen,
  summarizeBreakers,
  DEFAULT_BREAKER_MIN_SAMPLES,
  DEFAULT_BREAKER_WINDOW,
  DEFAULT_BREAKER_MIN_SUCCESS_RATE,
} from '../src/services/dev-autopilot-scanner-breaker';
import { buildAlerts, diagnoseFinding } from '../src/services/dev-autopilot-supervisor';

const OUTAGE = { error: 'LLM call failed on turn 1: both providers failed: primary=Bedrock invoke_failed: Operation not allowed; fallback=DeepSeek 402' };
const REAL = { error: 'tsc failed after 3 fix round(s)' };
const T = (i: number) => new Date(1_800_000_000_000 - i * 60_000).toISOString();

describe('breakerKeyFor', () => {
  it('uses spec_snapshot.scanner, impact:<rule>, then source_type', () => {
    expect(breakerKeyFor({ source_type: 'dev_autopilot', spec_snapshot: { scanner: 'todo-scanner-v1' } })).toBe('todo-scanner-v1');
    expect(breakerKeyFor({ source_type: 'dev_autopilot_impact', spec_snapshot: { scanner: 'impact:new-env-var-requires-workflow-binding' } }))
      .toBe('impact:new-env-var-requires-workflow-binding');
    expect(breakerKeyFor({ source_type: 'dev_autopilot_impact', spec_snapshot: { rule: 'r1' } })).toBe('impact:r1');
    expect(breakerKeyFor({ source_type: 'missing-test-scanner', spec_snapshot: null })).toBe('missing-test-scanner');
    expect(breakerKeyFor({ scanner: 'flat-scanner', source_type: 'x' })).toBe('flat-scanner');
    expect(breakerKeyFor(null)).toBeNull();
  });
});

describe('classifyExecution', () => {
  it('success = completed / self_healed', () => {
    expect(classifyExecution('completed')).toBe('success');
    expect(classifyExecution('self_healed')).toBe('success');
  });
  it('failure = failed* / reverted, but an outage-class failure is ignored', () => {
    expect(classifyExecution('failed', REAL)).toBe('failure');
    expect(classifyExecution('failed_escalated', REAL)).toBe('failure');
    expect(classifyExecution('reverted', REAL)).toBe('failure');
    expect(classifyExecution('failed', OUTAGE)).toBeNull();
    expect(classifyExecution('reverted', OUTAGE)).toBeNull();
  });
  it('cancelled / rejected / in-flight are ignored', () => {
    for (const s of ['cancelled', 'rejected', 'running', 'cooling', 'awaiting_approval', 'ci']) {
      expect(classifyExecution(s)).toBeNull();
    }
  });
});

describe('computeBreakerStates', () => {
  const rows = (key: string, statuses: string[], meta = REAL) =>
    statuses.map((status, i) => ({ key, status, updated_at: T(i), metadata: meta }));

  it('opens at 5 decided samples with < 20 % success (the 74-and-0 case)', () => {
    const st = computeBreakerStates(rows('todo-scanner-v1', ['failed', 'failed', 'reverted', 'failed_escalated', 'failed']));
    expect(st.get('todo-scanner-v1')).toEqual(expect.objectContaining({ samples: 5, successes: 0, open: true }));
  });
  it('stays closed with fewer than MIN_SAMPLES decided executions', () => {
    const st = computeBreakerStates(rows('s', ['failed', 'failed', 'failed', 'failed']));
    expect(st.get('s')!.open).toBe(false);
  });
  it('stays closed at exactly 20 % success', () => {
    const st = computeBreakerStates(rows('s', ['completed', 'failed', 'failed', 'failed', 'failed']));
    expect(st.get('s')).toEqual(expect.objectContaining({ success_rate: 0.2, open: false }));
  });
  it('only the newest WINDOW decided executions count', () => {
    // 10 newest are successes; 30 older failures are outside the window.
    const r = [...rows('s', Array(10).fill('completed')), ...rows('s', Array(30).fill('failed')).map((x, i) => ({ ...x, updated_at: T(100 + i) }))];
    expect(computeBreakerStates(r).get('s')).toEqual(expect.objectContaining({ samples: 10, successes: 10, open: false }));
  });
  it('467 outage failures never open a breaker (they are not the rule\'s fault)', () => {
    const r = rows('impact:new-env-var-requires-workflow-binding', Array(467).fill('failed'), OUTAGE);
    expect(computeBreakerStates(r).get('impact:new-env-var-requires-workflow-binding')).toBeUndefined();
  });
  it('rows without a key are skipped; keys are independent', () => {
    const r = [...rows('a', Array(5).fill('failed')), ...rows('b', Array(5).fill('completed')), { key: null, status: 'failed', updated_at: T(1), metadata: REAL }];
    const st = computeBreakerStates(r);
    expect(st.get('a')!.open).toBe(true);
    expect(st.get('b')!.open).toBe(false);
    expect(st.size).toBe(2);
  });
});

describe('resolveBreakerThresholds', () => {
  it('defaults', () => {
    expect(resolveBreakerThresholds({})).toEqual({ min_samples: DEFAULT_BREAKER_MIN_SAMPLES, window: DEFAULT_BREAKER_WINDOW, min_success_rate: DEFAULT_BREAKER_MIN_SUCCESS_RATE });
    expect([DEFAULT_BREAKER_MIN_SAMPLES, DEFAULT_BREAKER_WINDOW, DEFAULT_BREAKER_MIN_SUCCESS_RATE]).toEqual([5, 10, 0.2]);
  });
  it('env overrides; garbage falls back; min_samples never exceeds the window', () => {
    expect(resolveBreakerThresholds({ DEV_AUTOPILOT_BREAKER_MIN_SAMPLES: '3', DEV_AUTOPILOT_BREAKER_WINDOW: '20', DEV_AUTOPILOT_BREAKER_MIN_SUCCESS_RATE: '0.5' }))
      .toEqual({ min_samples: 3, window: 20, min_success_rate: 0.5 });
    expect(resolveBreakerThresholds({ DEV_AUTOPILOT_BREAKER_WINDOW: 'x', DEV_AUTOPILOT_BREAKER_MIN_SUCCESS_RATE: '7' }))
      .toEqual({ min_samples: 5, window: 10, min_success_rate: 0.2 });
    expect(resolveBreakerThresholds({ DEV_AUTOPILOT_BREAKER_MIN_SAMPLES: '9', DEV_AUTOPILOT_BREAKER_WINDOW: '4' }).min_samples).toBe(4);
  });
});

describe('loadScannerBreakers + one OASIS event per transition', () => {
  beforeEach(() => { resetScannerBreakerCache(); (emitOasisEvent as jest.Mock).mockClear(); });

  function query(execs: Array<{ finding_id: string; status: string; metadata?: unknown }>, recs: Array<{ id: string; source_type: string; scanner: string | null; rule: string | null }>) {
    const calls: string[] = [];
    const q = jest.fn(async (p: string) => {
      calls.push(p);
      if (p.startsWith('/rest/v1/dev_autopilot_executions?')) return { ok: true, data: execs.map((e, i) => ({ ...e, updated_at: T(i), metadata: e.metadata ?? REAL })) };
      if (p.startsWith('/rest/v1/autopilot_recommendations?id=in.(')) return { ok: true, data: recs };
      return { ok: false };
    });
    return { q, calls };
  }
  const failing = Array.from({ length: 6 }, (_, i) => ({ finding_id: `f${i % 2}`, status: 'failed' }));
  const recs = [
    { id: 'f0', source_type: 'dev_autopilot', scanner: 'todo-scanner-v1', rule: null },
    { id: 'f1', source_type: 'dev_autopilot', scanner: 'todo-scanner-v1', rule: null },
  ];

  it('reads decided executions + their findings and opens the breaker, emitting opened once', async () => {
    const { q, calls } = query(failing, recs);
    const a = await loadScannerBreakers(q as any, { emitTransitions: true, useCache: false });
    expect(a.ok).toBe(true);
    expect(a.states.get('todo-scanner-v1')!.open).toBe(true);
    expect(calls[0]).toContain('status=in.(completed,self_healed,failed,failed_escalated,reverted)');
    expect(calls[1]).toContain('scanner:spec_snapshot->>scanner');
    await loadScannerBreakers(q as any, { emitTransitions: true, useCache: false });
    const types = (emitOasisEvent as jest.Mock).mock.calls.map((c) => c[0].type);
    expect(types).toEqual(['dev_autopilot.scanner_breaker.opened']);
    expect((emitOasisEvent as jest.Mock).mock.calls[0][0]).toEqual(expect.objectContaining({ vtid: 'VTID-04667', payload: expect.objectContaining({ key: 'todo-scanner-v1', samples: 6, successes: 0 }) }));
  });

  it('emits closed when the scanner recovers', async () => {
    await loadScannerBreakers(query(failing, recs).q as any, { emitTransitions: true, useCache: false });
    const recovered = Array.from({ length: 6 }, (_, i) => ({ finding_id: `f${i % 2}`, status: 'completed' }));
    await loadScannerBreakers(query(recovered, recs).q as any, { emitTransitions: true, useCache: false });
    expect((emitOasisEvent as jest.Mock).mock.calls.map((c) => c[0].type))
      .toEqual(['dev_autopilot.scanner_breaker.opened', 'dev_autopilot.scanner_breaker.closed']);
  });

  it('a read failure fails open (no states, no events)', async () => {
    const a = await loadScannerBreakers((async () => ({ ok: false })) as any, { emitTransitions: true, useCache: false });
    expect(a.ok).toBe(false);
    expect(a.states.size).toBe(0);
    expect(emitOasisEvent).not.toHaveBeenCalled();
  });

  it('caches for 60 s by default', async () => {
    const { q } = query(failing, recs);
    await loadScannerBreakers(q as any, { nowMs: 1000 });
    await loadScannerBreakers(q as any, { nowMs: 30_000 });
    expect(q).toHaveBeenCalledTimes(2); // one executions read + one recommendations read, once
  });

  it('isFindingBreakerOpen never pauses a human-requested operator_onramp finding', async () => {
    const opRecs = recs.map((r) => ({ ...r, source_type: 'operator_onramp', scanner: null }));
    const a = await loadScannerBreakers(query(failing, opRecs).q as any, { useCache: false });
    expect(a.states.get('operator_onramp')!.open).toBe(true);
    expect(isFindingBreakerOpen(a, { source_type: 'operator_onramp', spec_snapshot: null })).toBe(false);
    const b = await loadScannerBreakers(query(failing, recs).q as any, { useCache: false });
    expect(isFindingBreakerOpen(b, { source_type: 'dev_autopilot', spec_snapshot: { scanner: 'todo-scanner-v1' } })).toBe(true);
    expect(isFindingBreakerOpen(b, { source_type: 'dev_autopilot', spec_snapshot: { scanner: 'other' } })).toBe(false);
    expect(summarizeBreakers(b).open).toEqual(['todo-scanner-v1']);
  });
});

describe('supervisor surfaces the breaker', () => {
  const base = {
    cfg: { kill_switch: false } as any,
    scan: { overdue: false, failed_7d: 0, stuck_runs: [] } as any,
    exec: { success_rate_7d: null, failed_7d: 0, top_failure_reasons: [], by_origin_7d: {}, awaiting_approval: 0 } as any,
    blockers: {},
    communityEngineLastRunAt: new Date().toISOString(),
    nowMs: Date.now(),
  };
  it('alerts naming the paused scanners', () => {
    const a = buildAlerts({ ...base, openBreakers: ['todo-scanner-v1', 'impact:x'] });
    const hit = a.find((x) => /Circuit breaker paused 2/.test(x.text));
    expect(hit?.text).toContain('todo-scanner-v1');
    expect(buildAlerts({ ...base, openBreakers: [] }).some((x) => /Circuit breaker/.test(x.text))).toBe(false);
  });
  it('diagnoses an eligible finding as paused by its breaker', () => {
    const cfg = { kill_switch: false, auto_approve_enabled: true, auto_approve_impact_enabled: false, auto_approve_risk_classes: ['low'], auto_approve_max_effort: 5, auto_approve_scanners: ['todo-scanner-v1'], auto_approve_impact_rules: [], daily_budget: 5, concurrency_cap: 2 };
    const f = { id: 'x', title: 't', status: 'new', source_type: 'dev_autopilot', risk_class: 'low', effort_score: 1, impact_score: 5, snoozed_until: null, created_at: T(0), spec_snapshot: { scanner: 'todo-scanner-v1' } };
    const d = diagnoseFinding(f, { cfg, hasPlan: true, execs: [], planFailures: { count: 0, lastMs: null }, nowMs: Date.now(), budgetLeft: 5, concurrencyLeft: 2, breakerOpen: true });
    expect(d).toEqual(expect.objectContaining({ code: 'scanner_breaker_open', actor: 'system' }));
    expect(d.label).toContain('todo-scanner-v1');
  });
});
