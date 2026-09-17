/**
 * VTID-04031 (W4g): the cost / model of an Operator Console turn is visible.
 *
 * Pinned here: the pure cost helpers (pricing-key normalisation for Bedrock
 * profile ids, unpriced models reported honestly, the per-turn fold), the
 * reply meta and the `model.turn` frames carrying usage + cost through the
 * real processWithGemini path, and the Command Hub client (badge on the
 * reply's meta row, model-call lines in the live transcript, styles and
 * cache-bust shipped together).
 */

import * as fs from 'fs';
import * as path from 'path';

jest.mock('../src/services/llm-router', () => {
  const actual = jest.requireActual('../src/services/llm-router');
  return { ...actual, callViaRouter: jest.fn() };
});
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../src/services/dev-agent-memory', () => ({
  recallDevMemory: jest.fn().mockResolvedValue({ ok: true, hits: [] }),
  writeDevMemory: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../src/services/operator-bootstrap-pack', () => ({
  getOperatorBootstrapPack: jest.fn().mockResolvedValue(''),
}));

import { callViaRouter } from '../src/services/llm-router';
import { MODEL_COSTS, estimateCost } from '../src/constants/llm-defaults';
import {
  pricingKeyForModel,
  isModelPriced,
  turnUsageFields,
  summarizeTurnCost,
} from '../src/services/operator-turn-cost';
import { processWithGemini, type OperatorTurnEvent } from '../src/services/gemini-operator';

const routerMock = callViaRouter as jest.Mock;

const FE = path.resolve(__dirname, '../src/frontend/command-hub');
const APP_JS = fs.readFileSync(path.join(FE, 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(FE, 'styles.css'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(FE, 'index.html'), 'utf8');

function fnBody(name: string): string {
  // Anchor on the definition at column 0 — a mention in a comment or a call
  // site earlier in the file must not select the wrong slice.
  const start = APP_JS.indexOf(`\nfunction ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = APP_JS.indexOf('\nfunction ', start + 1);
  return APP_JS.slice(start, next === -1 ? undefined : next);
}

describe('VTID-04031 pricing key and per-call fields', () => {
  it('uses the exact id when priced, reduces a Bedrock profile id to the bare Anthropic name, and knows what it does not know', () => {
    expect(pricingKeyForModel('deepseek-flash')).toBe('deepseek-flash');
    expect(pricingKeyForModel('eu.anthropic.claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(pricingKeyForModel('global.anthropic.claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(pricingKeyForModel('eu.anthropic.claude-opus-4-5-20251101-v1:0')).toBe(MODEL_COSTS['claude-opus-4-5'] ? 'claude-opus-4-5' : null);
    expect(pricingKeyForModel('router')).toBeNull();
    expect(pricingKeyForModel('')).toBeNull();
    expect(pricingKeyForModel(undefined)).toBeNull();
    expect(isModelPriced('deepseek-flash')).toBe(true);
    expect(isModelPriced('some-unknown-model')).toBe(false);
  });

  it('turnUsageFields: router usage → tokens + estimated cost; unknown model → cost 0 and cost_priced false; no usage → nothing', () => {
    const f = turnUsageFields('deepseek-flash', { inputTokens: 10_000, outputTokens: 2_000 });
    expect(f.usage).toEqual({ input_tokens: 10_000, output_tokens: 2_000 });
    expect(f.cost_priced).toBe(true);
    expect(f.cost_usd).toBeCloseTo(estimateCost('deepseek-flash', 10_000, 2_000), 6);
    expect(f.cost_usd).toBeGreaterThan(0);

    const bedrock = turnUsageFields('eu.anthropic.claude-sonnet-4-6', { inputTokens: 1_000_000, outputTokens: 0 });
    expect(bedrock.cost_usd).toBeCloseTo(MODEL_COSTS['claude-sonnet-4-6'].input, 6);

    const unknown = turnUsageFields('router', { inputTokens: 5, outputTokens: 5 });
    expect(unknown).toEqual({ usage: { input_tokens: 5, output_tokens: 5 }, cost_usd: 0, cost_priced: false });

    expect(turnUsageFields('deepseek-flash', undefined)).toEqual({});
    expect(turnUsageFields('deepseek-flash', { inputTokens: 0, outputTokens: 0 })).toEqual({});
    expect(turnUsageFields('deepseek-flash', { input_tokens: 3, output_tokens: 4 })).toMatchObject({ usage: { input_tokens: 3, output_tokens: 4 } });
  });

  it('summarizeTurnCost folds the plan and final calls, sums tokens and cost, and is unpriced if any priced-less call ran', () => {
    const s = summarizeTurnCost([
      { model: 'deepseek-flash', usage: { inputTokens: 3_000, outputTokens: 500 } },
      { model: 'deepseek-flash', usage: { inputTokens: 4_000, outputTokens: 900 } },
    ]);
    expect(s.usage).toEqual({ input_tokens: 7_000, output_tokens: 1_400 });
    expect(s.model_calls).toBe(2);
    expect(s.cost_priced).toBe(true);
    expect(s.cost_usd).toBeCloseTo(estimateCost('deepseek-flash', 3_000, 500) + estimateCost('deepseek-flash', 4_000, 900), 6);

    const mixed = summarizeTurnCost([
      { model: 'deepseek-flash', usage: { inputTokens: 100, outputTokens: 10 } },
      { model: 'mystery', usage: { inputTokens: 100, outputTokens: 10 } },
      { model: 'deepseek-flash', usage: undefined },
    ]);
    expect(mixed.model_calls).toBe(2);
    expect(mixed.cost_priced).toBe(false);
    expect(mixed.usage).toEqual({ input_tokens: 200, output_tokens: 20 });

    expect(summarizeTurnCost([])).toEqual({ usage: { input_tokens: 0, output_tokens: 0 }, cost_usd: 0, cost_priced: false, model_calls: 0 });
  });
});

describe('VTID-04031 the turn carries usage + cost through processWithGemini', () => {
  beforeEach(() => routerMock.mockReset());

  it('no tool call: meta has usage, cost_usd, cost_priced, model_calls and duration_ms; model.turn(plan) carries the same usage', async () => {
    routerMock.mockResolvedValue({ ok: true, text: 'direct', provider: 'deepseek', model: 'deepseek-flash', toolCalls: [], usage: { inputTokens: 2_500, outputTokens: 300 } });
    const events: OperatorTurnEvent[] = [];
    const r = await processWithGemini({ text: 'hello', threadId: 't-cost-1', onEvent: (e) => events.push(e) } as any);
    expect(r.meta).toMatchObject({ provider: 'deepseek', model: 'deepseek-flash', tool_calls: 0, usage: { input_tokens: 2_500, output_tokens: 300 }, cost_priced: true, model_calls: 1 });
    expect((r.meta as any).cost_usd).toBeCloseTo(estimateCost('deepseek-flash', 2_500, 300), 6);
    expect(typeof (r.meta as any).duration_ms).toBe('number');
    const plan = events[0] as Extract<OperatorTurnEvent, { type: 'model.turn' }>;
    expect(plan.type).toBe('model.turn');
    expect(plan.usage).toEqual({ input_tokens: 2_500, output_tokens: 300 });
    expect(plan.cost_priced).toBe(true);
  });

  it('with a tool round: both model calls are folded and the final model.turn reports the final call', async () => {
    let call = 0;
    routerMock.mockImplementation(async () => {
      call += 1;
      if (call === 1) return { ok: true, text: '', provider: 'deepseek', model: 'deepseek-flash', toolCalls: [{ name: 'run_code', arguments: { code: '1 + 1' } }], usage: { inputTokens: 1_000, outputTokens: 50 } };
      return { ok: true, text: 'two', provider: 'bedrock', model: 'eu.anthropic.claude-sonnet-4-6', toolCalls: [], usage: { inputTokens: 700, outputTokens: 20 } };
    });
    const events: OperatorTurnEvent[] = [];
    const r = await processWithGemini({ text: 'what is 1+1', threadId: 't-cost-2', onEvent: (e) => events.push(e) } as any);
    expect((r.meta as any).usage).toEqual({ input_tokens: 1_700, output_tokens: 70 });
    expect((r.meta as any).model_calls).toBe(2);
    expect((r.meta as any).cost_priced).toBe(true);
    expect((r.meta as any).cost_usd).toBeCloseTo(estimateCost('deepseek-flash', 1_000, 50) + estimateCost('claude-sonnet-4-6', 700, 20), 6);
    const turns = events.filter((e): e is Extract<OperatorTurnEvent, { type: 'model.turn' }> => e.type === 'model.turn');
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ stage: 'plan', model: 'deepseek-flash', usage: { input_tokens: 1_000, output_tokens: 50 } });
    expect(turns[1]).toMatchObject({ stage: 'final', provider: 'bedrock', model: 'eu.anthropic.claude-sonnet-4-6', usage: { input_tokens: 700, output_tokens: 20 }, cost_priced: true });
  });

  it('a provider that reports no usage leaves the reply meta honest: zero tokens, unpriced, no usage on the frame', async () => {
    routerMock.mockResolvedValue({ ok: true, text: 'direct', provider: 'deepseek', model: 'deepseek-flash', toolCalls: [] });
    const events: OperatorTurnEvent[] = [];
    const r = await processWithGemini({ text: 'hello', threadId: 't-cost-3', onEvent: (e) => events.push(e) } as any);
    expect((r.meta as any).usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect((r.meta as any).cost_priced).toBe(false);
    expect((r.meta as any).model_calls).toBe(0);
    expect((events[0] as any).usage).toBeUndefined();
  });
});

describe('VTID-04031 Command Hub client', () => {
  it('renders the badge on a reply meta row from the reply meta, never on sent messages', () => {
    const body = fnBody('renderOperatorChat');
    expect(body).toContain("if (!isSent && msg.meta && msg.meta.provider) {");
    expect(body).toContain("badge.className = 'message-cost-badge';");
    expect(body).toContain('var badgeText = formatTurnCostBadge(msg.meta);');
    expect(body).toContain('badge.textContent = badgeText;');
    expect(body).toContain('badge.title = describeTurnCost(msg.meta);');
  });

  it('formats provider · model · duration · tokens · cost, says "unpriced" for an unknown model, and never invents a cost', () => {
    const badge = fnBody('formatTurnCostBadge');
    expect(badge).toContain("if (!meta || !meta.provider) return '';");
    expect(badge).toContain('formatToolDuration(meta.duration_ms)');
    expect(badge).toContain("'\\u2191 '");
    const cost = fnBody('formatTurnCostUsd');
    expect(cost).toContain("if (meta.cost_priced === false) return 'unpriced';");
    expect(cost).toContain("if (!meta || !meta.usage) return '';");
    expect(fnBody('formatTokenCount')).toContain("toFixed(1) + 'k'");
  });

  it('shows each model call in the live transcript with its cost fields, and keeps "Thinking" only while nothing has happened', () => {
    const live = fnBody('renderOperatorLiveTranscript');
    expect(live).toContain('state.chatLiveModelTurns.forEach(function (d) {');
    expect(live).toContain("chat-tool-activity-line--model");
    expect(live).toContain('usage: d.usage, cost_usd: d.cost_usd, cost_priced: d.cost_priced');
    expect(live).toContain('if (state.chatLiveTranscript.length === 0 && state.chatLiveModelTurns.length === 0) {');
  });

  it('ships the styles and bumps the cache-bust version', () => {
    expect(CSS).toContain('.message-cost-badge {');
    expect(CSS).toContain('.chat-tool-activity-line--model {');
    expect(INDEX_HTML).toContain('app.js?v=20260917-vtid-04031-turn-cost-badge');
    expect(INDEX_HTML).toContain('styles.css?v=20260917-vtid-04031-turn-cost-badge');
  });
});
