/**
 * VTID-05077 (Dev Autopilot autonomy, Phase A): the planner keeps DeepSeek as
 * its primary with thinking OFF, falls back to Bedrock Opus 4.6 through a
 * per-call fallback override (the shared `planner` policy row is unchanged),
 * and every failure carries a real reason.
 *
 * Harness: same as vtid-04794-router-empty-truncated-fallback.test.ts, plus a
 * jest mock of the Bedrock provider so the fallback's model id is observable.
 */
import { LLM_SAFE_DEFAULTS } from '../src/constants/llm-defaults';

const bedrockCalls: Array<{ model: string }> = [];
jest.mock('../src/providers/bedrock', () => {
  const actual = jest.requireActual('../src/providers/bedrock');
  return {
    ...actual,
    invokeBedrock: jest.fn(async (req: { model: string }) => {
      bedrockCalls.push({ model: req.model });
      return { ok: true, text: `## Plan from ${req.model}`, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 20 }, latencyMs: 5 };
    }),
  };
});

describe('VTID-05077 router: per-call fallback override and DeepSeek thinking', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  let deepseekBodies: any[];

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.resetModules();
    bedrockCalls.length = 0;
    deepseekBodies = [];
    process.env.DEEPSEEK_API_KEY = 'ds-test';
    process.env.ANTHROPIC_API_KEY = 'an-test';
    process.env.BEDROCK_ROLE_ARN = 'arn:aws:iam::000000000000:role/test';
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE = 'test-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.BEDROCK_ROLE_ARN;
  });

  const deepseekReply = (content: string, finish: string, reasoning?: number) =>
    new Response(JSON.stringify({
      choices: [{ finish_reason: finish, message: { content } }],
      usage: { prompt_tokens: 6415, completion_tokens: 8000, ...(reasoning !== undefined ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}) },
    }), { status: 200 });

  function stub(deepseek: () => Response) {
    // The shared planner row's fallback is the direct Anthropic API here, so a
    // call that reaches Anthropic proves the override was NOT applied.
    const policy = {
      ...LLM_SAFE_DEFAULTS,
      planner: { primary_provider: 'bedrock', primary_model: 'eu.anthropic.claude-sonnet-4-6', fallback_provider: 'anthropic', fallback_model: 'claude-sonnet-4-6' },
    };
    const calls: string[] = [];
    fetchMock.mockImplementation(async (input: any, init: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/rest/v1/llm_routing_policy')) {
        return new Response(JSON.stringify([{ policy }]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/rest/v1/')) return new Response('', { status: 201 });
      if (url.includes('api.deepseek.com')) { calls.push('deepseek'); deepseekBodies.push(JSON.parse(init.body)); return deepseek(); }
      if (url.includes('api.anthropic.com')) {
        calls.push('anthropic');
        return new Response(JSON.stringify({ content: [{ type: 'text', text: '## Plan from the policy fallback' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    return calls;
  }

  async function router() {
    const m = await import('../src/services/llm-router');
    m._resetPolicyCacheForTests();
    return m;
  }

  const plannerOpts = {
    service: 'test',
    maxTokens: 8000,
    providerOverride: 'deepseek' as const,
    modelOverride: 'deepseek-flash',
  };

  it('a failed DeepSeek primary is served by the override (Opus 4.6), not the policy fallback', async () => {
    const calls = stub(() => deepseekReply('', 'length', 8000));
    const { callViaRouter } = await router();
    const r = await callViaRouter('planner', 'plan', { ...plannerOpts, fallbackOverride: { provider: 'bedrock', model: 'eu.anthropic.claude-opus-4-6-v1' } });
    expect(calls).toEqual(['deepseek']);
    expect(bedrockCalls).toEqual([{ model: 'eu.anthropic.claude-opus-4-6-v1' }]);
    expect(r.ok).toBe(true);
    expect(r.fallbackUsed).toBe(true);
    expect(r.model).toBe('eu.anthropic.claude-opus-4-6-v1');
  });

  it('without an override the policy fallback applies exactly as before', async () => {
    const calls = stub(() => deepseekReply('', 'length'));
    const { callViaRouter } = await router();
    const r = await callViaRouter('planner', 'plan', plannerOpts);
    expect(calls).toEqual(['deepseek', 'anthropic']);
    expect(r.text).toBe('## Plan from the policy fallback');
  });

  it.each(['vertex', 'anthropic', 'claude_subscription'])('a %s fallback override is refused; the policy fallback applies', async (provider) => {
    const calls = stub(() => deepseekReply('', 'length'));
    const { callViaRouter } = await router();
    const r = await callViaRouter('planner', 'plan', { ...plannerOpts, fallbackOverride: { provider: provider as any, model: 'x' } });
    expect(calls).toEqual(['deepseek', 'anthropic']);
    expect(r.ok).toBe(true);
  });

  it('the override never writes into the cached policy (the next call without it uses the policy fallback)', async () => {
    const calls = stub(() => deepseekReply('', 'length'));
    const { callViaRouter } = await router();
    // No primary override here, so the router works on the policy's own stage
    // object: the override must land on a copy of it, never on the cache.
    await callViaRouter('planner', 'plan', { service: 'test', fallbackOverride: { provider: 'bedrock', model: 'eu.anthropic.claude-opus-4-6-v1' } });
    await callViaRouter('planner', 'plan', plannerOpts);
    expect(calls).toEqual(['deepseek', 'anthropic']);
    expect(bedrockCalls).toEqual([{ model: 'eu.anthropic.claude-sonnet-4-6' }]);
  });

  it('a no-fallback stage ignores a fallback override', async () => {
    stub(() => deepseekReply('x', 'stop'));
    const { callViaRouter } = await router();
    const r = await callViaRouter('plan_sparring', 'review', { service: 'test', fallbackOverride: { provider: 'deepseek', model: 'deepseek-flash' } });
    // plan_sparring runs on Bedrock only; the mock answers, and no fallback is ever taken.
    expect(r.fallbackUsed).toBeFalsy();
  });

  it('deepseekThinking=disabled is sent as thinking:{type:"disabled"}; omitted, the body has no thinking field', async () => {
    stub(() => deepseekReply('## plan', 'stop'));
    const { callViaRouter } = await router();
    await callViaRouter('planner', 'plan', { ...plannerOpts, deepseekThinking: 'disabled' });
    await callViaRouter('planner', 'plan', plannerOpts);
    expect(deepseekBodies[0].thinking).toEqual({ type: 'disabled' });
    expect('thinking' in deepseekBodies[1]).toBe(false);
  });

  it('an empty capped reply names its reasoning tokens in the error', async () => {
    stub(() => deepseekReply('', 'length', 7990));
    const { callViaRouter } = await router();
    const r = await callViaRouter('planner', 'plan', { ...plannerOpts, allowFallback: false });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/output cap reached \(stop_reason=length, output_tokens=8000, reasoning_tokens=7990\)/);
  });
});

describe('VTID-05077 tool loop passes the fallback override and thinking switch to every turn', () => {
  it('each turn receives fallbackOverride and deepseekThinking', async () => {
    const { runStageToolLoop } = await import('../src/services/llm-stage-tool-loop');
    const seen: any[] = [];
    const r = await runStageToolLoop({
      stage: 'planner', service: 'test', systemPrompt: 's', prompt: 'p', tools: [],
      execute: async () => ({ ok: true, output: '' }) as any,
      providerOverride: 'deepseek', modelOverride: 'deepseek-flash',
      fallbackOverride: { provider: 'bedrock', model: 'eu.anthropic.claude-opus-4-6-v1' },
      deepseekThinking: 'disabled',
      callLlm: async (_stage, _prompt, opts) => { seen.push(opts); return { ok: true, text: 'done', provider: 'bedrock', model: 'eu.anthropic.claude-opus-4-6-v1', fallbackUsed: true } as any; },
    });
    expect(r.ok).toBe(true);
    expect(r.fallbackUsed).toBe(true);
    expect(seen[0].fallbackOverride).toEqual({ provider: 'bedrock', model: 'eu.anthropic.claude-opus-4-6-v1' });
    expect(seen[0].deepseekThinking).toBe('disabled');
  });
});

describe('VTID-05077 planner model choice and result mapping', () => {
  it('the planner fallback defaults to Bedrock Opus 4.6 and refuses Google, direct Anthropic and claude_subscription', async () => {
    const { devPlannerFallbackModel } = await import('../src/services/dev-pipeline-models');
    expect(devPlannerFallbackModel({})).toEqual({ provider: 'bedrock', model: 'eu.anthropic.claude-opus-4-6-v1' });
    for (const p of ['vertex', 'anthropic', 'claude_subscription']) {
      expect(devPlannerFallbackModel({ DEV_PLANNER_FALLBACK_PROVIDER: p, DEV_PLANNER_FALLBACK_MODEL: 'x' })).toEqual({ provider: 'bedrock', model: 'eu.anthropic.claude-opus-4-6-v1' });
    }
    expect(devPlannerFallbackModel({ DEV_PLANNER_FALLBACK_PROVIDER: 'bedrock', DEV_PLANNER_FALLBACK_MODEL: 'eu.other' })).toEqual({ provider: 'bedrock', model: 'eu.other' });
  });

  it('plannerCallResult never returns a bare "unknown error" and records who answered', async () => {
    const { plannerCallResult } = await import('../src/services/dev-autopilot-planning');
    expect(plannerCallResult({ ok: false, provider: 'deepseek', model: 'deepseek-flash' }).error).toMatch(/router returned ok=false without an error \(deepseek\/deepseek-flash\)/);
    expect(plannerCallResult({ ok: true, text: '  ', provider: 'deepseek', model: 'deepseek-flash', stopReason: 'length' }).error).toBe('deepseek/deepseek-flash returned an empty plan (stop_reason=length)');
    const ok = plannerCallResult({ ok: true, text: '## plan', provider: 'bedrock', model: 'eu.anthropic.claude-opus-4-6-v1', fallbackUsed: true, usage: { inputTokens: 1, outputTokens: 2 } });
    expect(ok).toMatchObject({ ok: true, provider: 'bedrock', model: 'eu.anthropic.claude-opus-4-6-v1', fallbackUsed: true, usage: { input_tokens: 1, output_tokens: 2 } });
  });
});

describe('VTID-05077 planner fallback rate on the autopilot screen', () => {
  it('summarizePlannerFallback counts plans written by a non-primary provider, ignoring rows from before the columns', async () => {
    const { summarizePlannerFallback } = await import('../src/services/dev-autopilot-outcomes');
    expect(summarizePlannerFallback([], 'deepseek')).toEqual({ plans_24h: 0, fallback_24h: 0, fallback_rate_24h: null });
    expect(summarizePlannerFallback([
      { planner_provider: 'deepseek' }, { planner_provider: 'deepseek' }, { planner_provider: 'bedrock' }, { planner_provider: null },
    ], 'deepseek')).toEqual({ plans_24h: 3, fallback_24h: 1, fallback_rate_24h: 0.333 });
  });

  it('the spend route returns the planner summary and the screen shows it as a chip', () => {
    const fs = require('fs');
    const path = require('path');
    const route = fs.readFileSync(path.join(__dirname, '../src/routes/dev-autopilot.ts'), 'utf8');
    expect(route).toMatch(/summarizePlannerFallback\(pv\.data \|\| \[\], devPlannerModel\(\)\.provider\)/);
    expect(route).toMatch(/return res\.json\(\{ ok: true, \.\.\.summary, planner \}\)/);
    const app = fs.readFileSync(path.join(__dirname, '../src/frontend/command-hub/app.js'), 'utf8');
    expect(app).toContain("label: 'Planner fallback 24h'");
    // VTID-05272 (H0): the chip renders the summary the route returns.
    expect(app).toContain("spend.planner.fallback_24h + '/' + spend.planner.plans_24h");
    const html = fs.readFileSync(path.join(__dirname, '../src/frontend/command-hub/index.html'), 'utf8');
    // VTID-05272 (H0): the served pin — index.html was bumped by VTID-05082 after this test was written.
    expect(html).toContain('/command-hub/app.js?v=20261121-vtid-05082');
  });

  it('plan versions record who wrote them (migration + insert)', () => {
    const fs = require('fs');
    const path = require('path');
    const mig = fs.readFileSync(path.join(__dirname, '../../../supabase/migrations/20261012110000_vtid_05077_plan_version_planner_model.sql'), 'utf8');
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS planner_provider text/);
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS planner_model text/);
    const planning = fs.readFileSync(path.join(__dirname, '../src/services/dev-autopilot-planning.ts'), 'utf8');
    expect(planning).toMatch(/planner_provider: writtenBy\.provider \?\? null,\s*planner_model: writtenBy\.model \?\? null,/);
    expect(planning).toContain("type: 'dev_autopilot.plan.fallback_used'");
  });
});
