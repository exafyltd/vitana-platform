/**
 * VTID-04868 — Plan Sparring Gate: the `plan_sparring` LLM stage, the
 * no-fallback rule, and the Bedrock thinking/effort request extensions.
 *
 * Nothing here calls Bedrock: the Bedrock SDK client is mocked and every
 * request body is captured and inspected.
 */

process.env.NODE_ENV = 'test';
process.env.BEDROCK_ROLE_ARN = 'arn:aws:iam::472838866351:role/test-role';
process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';

const sendMock = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: (...a: unknown[]) => sendMock(...a) })),
  InvokeModelCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

jest.mock('../src/services/llm-telemetry-service', () => ({
  startLLMCallDetached: jest.fn(() => ({ id: 'ctx' })),
  completeLLMCallDetached: jest.fn(async () => undefined),
  failLLMCallDetached: jest.fn(async () => undefined),
}));

const getActivePolicy = jest.fn();
jest.mock('../src/services/llm-routing-policy-service', () => ({
  getActivePolicy: (...args: unknown[]) => getActivePolicy(...(args as [])),
}));

import {
  LLM_SAFE_DEFAULTS,
  NO_FALLBACK_STAGES,
  OPTIONAL_STAGES,
  PLAN_SPARRING_DEFAULT_MODEL,
  RECOMMENDED_MODELS,
  VALID_STAGES,
  modelCostKey,
  resolvePlanSparringModel,
} from '../src/constants/llm-defaults';
import { buildBedrockRequestBody, parseBedrockContent } from '../src/providers/bedrock';
import { callViaRouter, _resetPolicyCacheForTests, type LLMRouterMessage } from '../src/services/llm-router';
import { PolicySchema } from '../src/routes/llm';

function bedrockReply(content: unknown[], stop_reason = 'end_turn') {
  return {
    body: new TextEncoder().encode(
      JSON.stringify({ content, stop_reason, usage: { input_tokens: 10, output_tokens: 5 } }),
    ),
  };
}
function sentBody(callIndex = 0): Record<string, unknown> {
  const cmd = sendMock.mock.calls[callIndex][0] as { input: { body: string; modelId: string } };
  return JSON.parse(cmd.input.body);
}

const SIX_STAGE = {
  primary_provider: 'bedrock',
  primary_model: 'eu.anthropic.claude-sonnet-4-6',
  fallback_provider: 'deepseek',
  fallback_model: 'deepseek-flash',
};
const LIVE_LIKE_POLICY = {
  planner: SIX_STAGE, worker: SIX_STAGE, validator: SIX_STAGE,
  operator: SIX_STAGE, memory: SIX_STAGE, triage: SIX_STAGE,
};

describe('VTID-04868 plan_sparring stage wiring', () => {
  it('is in every stage enumeration', () => {
    expect(VALID_STAGES).toContain('plan_sparring');
    expect(OPTIONAL_STAGES).toContain('plan_sparring');
    expect(NO_FALLBACK_STAGES).toEqual(['plan_sparring']);
    expect(LLM_SAFE_DEFAULTS.plan_sparring).toBeDefined();
    expect(RECOMMENDED_MODELS.plan_sparring.length).toBeGreaterThan(0);
  });

  it('defaults to Bedrock with NO fallback (never Sonnet/DeepSeek/Google)', () => {
    expect(LLM_SAFE_DEFAULTS.plan_sparring).toEqual({
      primary_provider: 'bedrock',
      primary_model: resolvePlanSparringModel(),
      fallback_provider: null,
      fallback_model: null,
    });
  });

  it('uses PLAN_SPARRING_MODEL when set, else the eu.* placeholder', () => {
    const prev = process.env.PLAN_SPARRING_MODEL;
    delete process.env.PLAN_SPARRING_MODEL;
    expect(resolvePlanSparringModel()).toBe(PLAN_SPARRING_DEFAULT_MODEL);
    expect(PLAN_SPARRING_DEFAULT_MODEL).toMatch(/^eu\.anthropic\.claude-opus-4-6/);
    process.env.PLAN_SPARRING_MODEL = 'eu.anthropic.claude-opus-4-6-verified';
    expect(resolvePlanSparringModel()).toBe('eu.anthropic.claude-opus-4-6-verified');
    if (prev === undefined) delete process.env.PLAN_SPARRING_MODEL;
    else process.env.PLAN_SPARRING_MODEL = prev;
  });

  it('prices the Opus 4.6 profile (not $0)', () => {
    expect(modelCostKey(PLAN_SPARRING_DEFAULT_MODEL)).toBe('claude-opus-4-6');
    // Existing suffix shapes still reduce exactly as before.
    expect(modelCostKey('eu.anthropic.claude-opus-4-5-20251101-v1:0')).toBe('claude-opus-4-5');
    expect(modelCostKey('eu.anthropic.claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('the route schema accepts an optional plan_sparring stage', () => {
    expect(PolicySchema.safeParse(LIVE_LIKE_POLICY).success).toBe(true);
    expect(PolicySchema.safeParse({ ...LIVE_LIKE_POLICY, plan_sparring: LLM_SAFE_DEFAULTS.plan_sparring }).success).toBe(true);
  });
});

describe('VTID-04868 policy validation rejects a fallback for plan_sparring', () => {
  const ORIGINAL_ENV = { ...process.env };
  const ALLOWLIST = [
    { provider_key: 'bedrock', model_id: 'eu.anthropic.claude-sonnet-4-6', applicable_stages: ['planner', 'worker', 'validator', 'operator', 'memory', 'triage', 'plan_sparring'] },
    { provider_key: 'deepseek', model_id: 'deepseek-flash', applicable_stages: ['planner', 'worker', 'validator', 'operator', 'memory', 'triage', 'plan_sparring'] },
    { provider_key: 'bedrock', model_id: PLAN_SPARRING_DEFAULT_MODEL, applicable_stages: ['plan_sparring'] },
  ];
  let validatePolicy: (p: never) => Promise<{ valid: boolean; errors: string[] }>;

  beforeAll(() => {
    jest.isolateModules(() => {
      jest.unmock('../src/services/llm-routing-policy-service');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      validatePolicy = jest.requireActual('../src/services/llm-routing-policy-service').validatePolicy;
    });
  });
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ALLOWLIST, text: async () => '' }) as unknown as typeof fetch;
  });
  afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

  it('accepts a Bedrock primary with a NULL fallback', async () => {
    const r = await validatePolicy({
      ...LIVE_LIKE_POLICY,
      plan_sparring: { primary_provider: 'bedrock', primary_model: PLAN_SPARRING_DEFAULT_MODEL, fallback_provider: null, fallback_model: null },
    } as never);
    expect(r.errors.filter((e) => e.includes('plan_sparring'))).toEqual([]);
  });

  it('rejects ANY non-null fallback', async () => {
    const r = await validatePolicy({
      ...LIVE_LIKE_POLICY,
      plan_sparring: { primary_provider: 'bedrock', primary_model: PLAN_SPARRING_DEFAULT_MODEL, fallback_provider: 'bedrock', fallback_model: 'eu.anthropic.claude-sonnet-4-6' },
    } as never);
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual(expect.arrayContaining([expect.stringMatching(/plan_sparring must not have a fallback/)]));
  });

  it('rejects a non-Bedrock primary', async () => {
    const r = await validatePolicy({
      ...LIVE_LIKE_POLICY,
      plan_sparring: { primary_provider: 'deepseek', primary_model: 'deepseek-flash', fallback_provider: null, fallback_model: null },
    } as never);
    expect(r.errors).toEqual(expect.arrayContaining([expect.stringMatching(/plan_sparring must use provider bedrock/)]));
  });

  it('still treats plan_sparring as optional (the live six-stage policy passes)', async () => {
    const r = await validatePolicy(LIVE_LIKE_POLICY as never);
    expect(r.errors.filter((e) => e.includes('plan_sparring'))).toEqual([]);
  });
});

describe('VTID-04868 router: plan_sparring never falls back', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetPolicyCacheForTests();
    global.fetch = jest.fn() as unknown as typeof fetch; // DeepSeek would go through fetch
  });

  it('resolves a stored policy WITHOUT plan_sparring to the compiled-in default', async () => {
    getActivePolicy.mockResolvedValue({ policy: LIVE_LIKE_POLICY });
    sendMock.mockResolvedValueOnce(bedrockReply([{ type: 'text', text: 'ok' }]));
    const r = await callViaRouter('plan_sparring', 'hi', { service: 'test' });
    expect(r.ok).toBe(true);
    expect(r.provider).toBe('bedrock');
    expect((sendMock.mock.calls[0][0] as { input: { modelId: string } }).input.modelId).toBe(resolvePlanSparringModel());
  });

  it('primary failure ⇒ error, zero other provider calls — even with allowFallback:true and a stored fallback', async () => {
    getActivePolicy.mockResolvedValue({
      policy: {
        ...LIVE_LIKE_POLICY,
        // A stored fallback that should never have passed validation:
        plan_sparring: { primary_provider: 'bedrock', primary_model: 'x', fallback_provider: 'deepseek', fallback_model: 'deepseek-flash' },
      },
    });
    sendMock.mockRejectedValueOnce(new Error('AccessDeniedException'));
    const r = await callViaRouter('plan_sparring', 'hi', { service: 'test', allowFallback: true });
    expect(r.ok).toBe(false);
    expect(r.fallbackUsed).toBe(false);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses a stored non-Bedrock primary without calling any provider', async () => {
    getActivePolicy.mockResolvedValue({
      policy: { ...LIVE_LIKE_POLICY, plan_sparring: { primary_provider: 'deepseek', primary_model: 'deepseek-flash', fallback_provider: null, fallback_model: null } },
    });
    const r = await callViaRouter('plan_sparring', 'hi', { service: 'test' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/must run on bedrock/);
    expect(sendMock).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses a per-call provider override to a non-Bedrock provider', async () => {
    getActivePolicy.mockResolvedValue({ policy: LIVE_LIKE_POLICY });
    const r = await callViaRouter('plan_sparring', 'hi', { service: 'test', providerOverride: 'deepseek', modelOverride: 'deepseek-flash' });
    expect(r.ok).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('other stages still fall back exactly as before', async () => {
    getActivePolicy.mockResolvedValue({ policy: LIVE_LIKE_POLICY });
    sendMock.mockRejectedValueOnce(new Error('boom'));
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'from deepseek' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      text: async () => '',
    });
    const r = await callViaRouter('planner', 'hi', { service: 'test' });
    expect(r.ok).toBe(true);
    expect(r.fallbackUsed).toBe(true);
    expect(r.provider).toBe('deepseek');
  });
});

describe('VTID-04868 Bedrock request extensions (thinking + output_config)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetPolicyCacheForTests();
    getActivePolicy.mockResolvedValue({ policy: LIVE_LIKE_POLICY });
  });

  it('default request body is unchanged: no thinking, no output_config, temperature kept, same key order', () => {
    const body = buildBedrockRequestBody({ model: 'm', messages: [{ role: 'user', content: 'hi' }], system: 's' });
    expect(Object.keys(body)).toEqual(['anthropic_version', 'max_tokens', 'temperature', 'system', 'messages']);
    expect(body.temperature).toBe(0.5);
    expect(JSON.stringify(body)).toBe(
      JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 2048, temperature: 0.5, system: 's', messages: [{ role: 'user', content: 'hi' }] }),
    );
  });

  it('thinking adaptive + effort are sent and temperature is dropped', () => {
    const body = buildBedrockRequestBody({
      model: 'm', messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, temperature: 0.2,
    });
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'high' });
    expect(body).not.toHaveProperty('temperature');
  });

  it('an existing stage through the router sends a byte-identical body (no thinking keys)', async () => {
    sendMock.mockResolvedValueOnce(bedrockReply([{ type: 'text', text: 'ok' }]));
    await callViaRouter('planner', 'hello', { service: 'test', systemPrompt: 'sys', maxTokens: 100 });
    expect(sentBody()).toEqual({
      anthropic_version: 'bedrock-2023-05-31', max_tokens: 100, temperature: 0.5, system: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('router passes thinking/effort through for Bedrock', async () => {
    sendMock.mockResolvedValueOnce(bedrockReply([{ type: 'text', text: 'ok' }]));
    await callViaRouter('plan_sparring', 'hello', { service: 'test', thinking: { type: 'adaptive' }, effort: 'high' });
    const body = sentBody();
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'high' });
    expect(body).not.toHaveProperty('temperature');
  });

  it('returns thinking + redacted_thinking blocks verbatim and in order', async () => {
    const thinking = { type: 'thinking', thinking: 'let me check', signature: 'sig-abc==', future_field: 1 };
    const redacted = { type: 'redacted_thinking', data: 'ENCRYPTED' };
    sendMock.mockResolvedValueOnce(
      bedrockReply([thinking, redacted, { type: 'text', text: 'reading' }, { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a' } }], 'tool_use'),
    );
    const r = await callViaRouter('plan_sparring', 'go', { service: 'test', thinking: { type: 'adaptive' } });
    expect(r.thinkingBlocks).toEqual([thinking, redacted]);
    expect(r.toolCalls).toEqual([{ id: 'tu_1', name: 'read_file', arguments: { path: 'a' } }]);
  });

  it('renders thinking blocks back VERBATIM, first in the assistant tool turn', async () => {
    const thinking = { type: 'thinking', thinking: 'let me check', signature: 'sig-abc==', future_field: 1 } as const;
    const redacted = { type: 'redacted_thinking', data: 'ENCRYPTED' } as const;
    const history: LLMRouterMessage[] = [
      { role: 'user', content: 'review this' },
      { role: 'assistant', content: 'reading', toolCalls: [{ id: 'tu_1', name: 'read_file', arguments: { path: 'a' } }], thinking: [thinking, redacted] },
      { role: 'user', toolResults: [{ id: 'tu_1', name: 'read_file', result: 'file body' }] },
    ];
    sendMock.mockResolvedValueOnce(bedrockReply([{ type: 'text', text: 'done' }]));
    await callViaRouter('plan_sparring', 'continue', { service: 'test', history, thinking: { type: 'adaptive' }, effort: 'high' });
    const msgs = sentBody().messages as Array<{ role: string; content: unknown }>;
    expect(msgs[1]).toEqual({
      role: 'assistant',
      content: [
        thinking,
        redacted,
        { type: 'text', text: 'reading' },
        { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a' } },
      ],
    });
    expect(msgs[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file body' }] });
  });

  it('parseBedrockContent copies thinking blocks without mutating the response', () => {
    const block = { type: 'thinking', thinking: 't', signature: 's' };
    const out = parseBedrockContent({ content: [block] });
    expect(out.thinkingBlocks).toEqual([block]);
    expect(out.thinkingBlocks[0]).not.toBe(block);
    expect(out.text).toBe('');
  });
});
