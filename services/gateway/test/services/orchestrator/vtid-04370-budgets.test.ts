/**
 * VTID-04370 — Orchestrator v2 P2 budgets (docs/ORCHESTRATOR-REDESIGN-PLAN.md §3.2, §5 P2).
 *
 * AC-1 Bedrock inference-profile ids are priced (router telemetry recorded $0
 *      for every Bedrock call before this).
 * AC-2 a row recorded at $0 with tokens is repriced from its tokens; truly
 *      unpriced models are counted, not guessed.
 * AC-3 a synthetic over-spend is a policy DENY naming the exhausted budget
 *      (platform, agent, run), and under-budget is allow.
 * AC-4 defaults: platform/day is the $6k monthly envelope over 30 days; the
 *      measured 09-22 planning spike would be denied.
 * AC-5 loadSpendToday reads only llm.call.completed since UTC midnight, pages,
 *      and never writes.
 */

import { estimateCost, modelCostKey } from '../../../src/constants/llm-defaults';
import {
  BUDGET_DEFAULTS,
  MONTHLY_ENVELOPE_USD,
  SPEND_PAGE,
  aggregateSpend,
  budgetLines,
  evaluateBudget,
  loadSpendToday,
  rowCostUsd,
} from '../../../src/services/orchestrator/budgets';

const row = (o: Partial<Parameters<typeof rowCostUsd>[0]>) => ({
  service: 'svc', vtid: null, model: null, input_tokens: 0, output_tokens: 0, cost_estimate_usd: 0, ...o,
});

describe('pricing (AC-1)', () => {
  test('Bedrock profile ids resolve to a priced model', () => {
    expect(modelCostKey('eu.anthropic.claude-opus-4-5-20251101-v1:0')).toBe('claude-opus-4-5');
    expect(modelCostKey('eu.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('claude-sonnet-4-5');
    expect(modelCostKey('eu.anthropic.claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(modelCostKey('global.anthropic.claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(modelCostKey('deepseek-flash')).toBe('deepseek-flash');
    expect(modelCostKey('no-such-model')).toBeNull();
    expect(estimateCost('eu.anthropic.claude-opus-4-5-20251101-v1:0', 1_000_000, 100_000)).toBeCloseTo(7.5, 6);
  });
});

describe('repricing (AC-2)', () => {
  test('a recorded cost is kept; a $0 row with tokens is repriced', () => {
    expect(rowCostUsd(row({ cost_estimate_usd: 0.5, model: 'eu.anthropic.claude-sonnet-4-6', input_tokens: 1e6 }))).toBe(0.5);
    expect(rowCostUsd(row({ model: 'eu.anthropic.claude-sonnet-4-6', input_tokens: 1e6 }))).toBeCloseTo(3, 6);
  });

  test('aggregate counts repriced and unpriced calls separately', () => {
    const t = aggregateSpend([
      row({ service: 'a', vtid: 'VTID-1', cost_estimate_usd: 1 }),
      row({ service: 'a', model: 'eu.anthropic.claude-sonnet-4-6', input_tokens: 1e6 }),
      row({ service: 'b', model: 'mystery', input_tokens: 10 }),
    ]);
    expect(t).toMatchObject({ platform_usd: 4, calls: 3, repriced_calls: 1, unpriced_calls: 1 });
    expect(t.by_agent).toEqual({ a: 4, b: 0 });
    expect(t.by_run).toEqual({ 'VTID-1': 1 });
  });
});

describe('evaluateBudget (AC-3)', () => {
  const spend = { platform_usd: 10, by_agent: { 'autopilot-agent': 59 }, by_run: { 'VTID-9': 7.5 } };

  test('under budget is allow', () => {
    expect(evaluateBudget(spend, { agent: 'autopilot-agent', vtid: 'VTID-9', estimated_usd: 0.1 }).decision).toBe('allow');
  });

  test('a synthetic agent over-spend is a deny naming the budget', () => {
    const d = evaluateBudget(spend, { agent: 'autopilot-agent', estimated_usd: 2 });
    expect(d).toMatchObject({ decision: 'deny', scope: 'agent', key: 'autopilot-agent', limit_usd: 60 });
  });

  test('a run over its daily line is denied even when the agent has room', () => {
    const d = evaluateBudget(spend, { agent: 'autopilot-agent', vtid: 'VTID-9', estimated_usd: 0.6 });
    expect(d.decision).toBe('deny');
    expect(['agent', 'run']).toContain(d.scope);
    const d2 = evaluateBudget({ ...spend, by_agent: {} }, { agent: 'autopilot-agent', vtid: 'VTID-9', estimated_usd: 0.6 });
    expect(d2).toMatchObject({ decision: 'deny', scope: 'run', key: 'VTID-9' });
  });

  test('the platform line is checked first', () => {
    const d = evaluateBudget({ platform_usd: 199.99, by_agent: {}, by_run: {} }, { agent: 'x', estimated_usd: 1 });
    expect(d).toMatchObject({ decision: 'deny', scope: 'platform' });
  });

  test('an unknown agent gets the default line', () => {
    expect(evaluateBudget({ platform_usd: 0, by_agent: { x: 10 }, by_run: {} }, { agent: 'x', estimated_usd: 0.01 }).decision).toBe('deny');
  });
});

describe('defaults (AC-4)', () => {
  test('platform per day is the monthly envelope over 30 days', () => {
    expect(BUDGET_DEFAULTS.platform_per_day_usd).toBe(200);
    expect(MONTHLY_ENVELOPE_USD).toBe(6000);
  });

  test('the measured 09-22 planning spike ($58) would be denied; the steady translator day ($33) would not', () => {
    const lines = budgetLines(aggregateSpend([
      row({ service: 'dev-autopilot-planning', cost_estimate_usd: 58.39 }),
      row({ service: 'db-i18n-translator', cost_estimate_usd: 33.32 }),
    ]));
    expect(lines.find((l) => l.key === 'dev-autopilot-planning')).toMatchObject({ over: true });
    expect(lines.find((l) => l.key === 'db-i18n-translator')).toMatchObject({ over: false });
    expect(lines[0].key).toBe('dev-autopilot-planning');
  });
});

describe('loadSpendToday (AC-5)', () => {
  function stub(pages: unknown[][]) {
    const seen: Array<Record<string, unknown>> = [];
    let n = 0;
    const sb = {
      from(table: string) {
        const q: Record<string, unknown> = { table };
        const chain: any = {
          select: (c: string) => { q.select = c; return chain; },
          eq: (k: string, v: unknown) => { q[`eq:${k}`] = v; return chain; },
          gte: (k: string, v: unknown) => { q[`gte:${k}`] = v; return chain; },
          order: () => chain,
          range: (a: number, b: number) => { q.range = [a, b]; seen.push(q); return Promise.resolve({ data: pages[n++] ?? [], error: null }); },
          insert: () => { throw new Error('write'); }, update: () => { throw new Error('write'); },
        };
        return chain;
      },
    } as any;
    return { sb, seen };
  }

  test('reads only llm.call.completed since UTC midnight and parses metadata', async () => {
    const { sb, seen } = stub([[{ metadata: { service: 'a', vtid: 'VTID-1', model: 'deepseek-flash', input_tokens: '10', output_tokens: 2, cost_estimate_usd: 0.1 } }]]);
    const r = await loadSpendToday(sb, new Date('2026-09-23T14:00:00Z'));
    expect(seen[0]).toMatchObject({ table: 'oasis_events', 'eq:topic': 'llm.call.completed', 'gte:created_at': '2026-09-23T00:00:00.000Z' });
    expect(r.rows[0]).toEqual({ service: 'a', vtid: 'VTID-1', model: 'deepseek-flash', input_tokens: 10, output_tokens: 2, cost_estimate_usd: 0.1 });
    expect(r.truncated).toBe(false);
  });

  test('pages until a short page', async () => {
    const full = Array.from({ length: SPEND_PAGE }, () => ({ metadata: {} }));
    const { sb, seen } = stub([full, [{ metadata: {} }]]);
    const r = await loadSpendToday(sb);
    expect(seen.map((q) => q.range)).toEqual([[0, SPEND_PAGE - 1], [SPEND_PAGE, 2 * SPEND_PAGE - 1]]);
    expect(r.rows).toHaveLength(SPEND_PAGE + 1);
  });
});
