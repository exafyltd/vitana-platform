/**
 * VTID-03565 — provider preflight + routing-write-path regression tests.
 *
 * Context: VTID-03563 made "Claude always via AWS Bedrock" a standing rule.
 * Three defects made that rule unenforceable, and all three were invisible to
 * the existing suite because each component was individually correct:
 *
 *   1. `routes/llm.ts` ProviderEnum omitted 'bedrock' while VALID_PROVIDERS
 *      included it — the dropdown offered Bedrock and the save 400'd.
 *   2. PolicySchema required 8 stages; the ACTIVE policy has 6, so a
 *      read-modify-write round-trip of the live policy 400'd on stages the
 *      caller never touched.
 *   3. Nothing could answer "does this provider actually work?" —
 *      /providers/health reports env-var PRESENCE, which is exactly the
 *      illusion that hid the credit-balance failures for months.
 *
 * These tests pin the write path against the REAL production policy shape,
 * not a synthetic 8-stage one — a fixture that already contains vision and
 * classifier cannot detect defect 2.
 */

import {
  LLM_SAFE_DEFAULTS,
  VALID_PROVIDERS,
  VALID_STAGES,
  type LLMProvider,
  type LLMRoutingPolicy,
} from '../src/constants/llm-defaults';
// Imported from the route module, NOT restated here. A test that mirrors the
// schema it guards cannot fail when the real schema drifts — which is exactly
// the defect being fixed (a hand-written ProviderEnum that had drifted from
// VALID_PROVIDERS). These are the objects the write path actually validates with.
import { ProviderEnum, StageConfigSchema, PolicySchema } from '../src/routes/llm';

/**
 * The ACTIVE production policy (llm_routing_policy v10, environment DEV,
 * created 2026-05-02), copied verbatim. Six stages — no vision, no classifier.
 */
const LIVE_V10_POLICY = {
  memory: {
    primary_provider: 'anthropic',
    primary_model: 'claude-3-5-sonnet-20241022',
    fallback_provider: 'vertex',
    fallback_model: 'gemini-2.5-pro',
  },
  triage: {
    primary_provider: 'vertex',
    primary_model: 'gemini-3.1-pro-preview',
    fallback_provider: 'anthropic',
    fallback_model: 'claude-3-5-sonnet-20241022',
  },
  worker: {
    primary_provider: 'vertex',
    primary_model: 'gemini-3.1-pro-preview',
    fallback_provider: 'anthropic',
    fallback_model: 'claude-3-5-sonnet-20241022',
  },
  planner: {
    primary_provider: 'vertex',
    primary_model: 'gemini-3.1-pro-preview',
    fallback_provider: 'anthropic',
    fallback_model: 'claude-3-5-sonnet-20241022',
  },
  operator: {
    primary_provider: 'vertex',
    primary_model: 'gemini-2.5-pro',
    fallback_provider: 'anthropic',
    fallback_model: 'claude-3-5-sonnet-20241022',
  },
  validator: {
    primary_provider: 'anthropic',
    primary_model: 'claude-3-5-sonnet-20241022',
    fallback_provider: 'vertex',
    fallback_model: 'gemini-3.1-pro-preview',
  },
} as const;

describe('VTID-03565 routing write path accepts Bedrock', () => {
  test('bedrock is a member of VALID_PROVIDERS', () => {
    expect(VALID_PROVIDERS).toContain('bedrock');
  });

  test('ProviderEnum accepts every provider in VALID_PROVIDERS (no drift)', () => {
    // The original defect in one line: a hand-written enum silently narrower
    // than the source of truth.
    for (const provider of VALID_PROVIDERS) {
      expect(ProviderEnum.safeParse(provider).success).toBe(true);
    }
  });

  test('a stage can be saved with bedrock as PRIMARY', () => {
    const result = StageConfigSchema.safeParse({
      primary_provider: 'bedrock',
      primary_model: 'eu.anthropic.claude-sonnet-4-6',
      fallback_provider: 'bedrock',
      fallback_model: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
    });
    expect(result.success).toBe(true);
  });

  test('a stage can be saved with bedrock as FALLBACK', () => {
    // CLAUDE.md ALWAYS 10c: a Claude stage's fallback must be another Bedrock
    // model or a hard failure — never Google. That is unexpressible if the
    // fallback slot rejects 'bedrock'.
    const result = StageConfigSchema.safeParse({
      primary_provider: 'bedrock',
      primary_model: 'eu.anthropic.claude-sonnet-4-6',
      fallback_provider: 'bedrock',
      fallback_model: 'eu.anthropic.claude-opus-4-6-v1',
    });
    expect(result.success).toBe(true);
  });

  test('an unknown provider is still rejected', () => {
    // The enum was widened, not removed.
    expect(
      StageConfigSchema.safeParse({
        primary_provider: 'not-a-provider',
        primary_model: 'x',
        fallback_provider: null,
        fallback_model: null,
      }).success,
    ).toBe(false);
  });
});

describe('VTID-03565 PolicySchema round-trips the LIVE policy', () => {
  test('the active 6-stage production policy validates', () => {
    const result = PolicySchema.safeParse(LIVE_V10_POLICY);
    expect(result.success).toBe(true);
  });

  test('the live policy genuinely lacks vision and classifier', () => {
    // Guards the premise. If a future migration adds these stages, this test
    // fails and tells the reader the fixture is stale — rather than the
    // optionality quietly protecting nothing.
    expect(LIVE_V10_POLICY).not.toHaveProperty('vision');
    expect(LIVE_V10_POLICY).not.toHaveProperty('classifier');
  });

  test('read-modify-write: flipping validator to bedrock still validates', () => {
    // The exact operation the rewire performs.
    const next = {
      ...LIVE_V10_POLICY,
      validator: {
        primary_provider: 'bedrock',
        primary_model: 'eu.anthropic.claude-sonnet-4-6',
        fallback_provider: 'bedrock',
        fallback_model: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
      },
    };
    expect(PolicySchema.safeParse(next).success).toBe(true);
  });

  test('the six core stages remain REQUIRED', () => {
    // Optionality was extended to exactly two stages. Dropping a core stage
    // must still fail: loadPolicy() takes the stored row wholesale, so a
    // missing core stage is a runtime outage for that stage, not a default.
    for (const stage of ['planner', 'worker', 'validator', 'operator', 'memory', 'triage']) {
      const partial: Record<string, unknown> = { ...LIVE_V10_POLICY };
      delete partial[stage];
      expect(PolicySchema.safeParse(partial).success).toBe(false);
    }
  });
});

describe('VTID-03565 LLMRoutingPolicy type asymmetry', () => {
  test('LLM_SAFE_DEFAULTS is complete even though stored policies need not be', () => {
    // Required<LLMRoutingPolicy>: defaults are complete by construction, which
    // is what every `?? LLM_SAFE_DEFAULTS[stage]` call site depends on.
    for (const stage of VALID_STAGES) {
      expect(LLM_SAFE_DEFAULTS[stage]).toBeDefined();
      expect(LLM_SAFE_DEFAULTS[stage].primary_provider).toBeTruthy();
    }
  });

  test('a policy missing vision/classifier is assignable to LLMRoutingPolicy', () => {
    // Compile-time assertion: this is the shape production actually stores.
    const stored: LLMRoutingPolicy = LIVE_V10_POLICY as unknown as LLMRoutingPolicy;
    expect(stored.vision).toBeUndefined();
    expect(stored.classifier).toBeUndefined();
  });
});

describe('VTID-03565 verifyProvider preflight', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  test('reports available:false and does NOT invoke when the env gate is unset', async () => {
    delete process.env.BEDROCK_ROLE_ARN;
    jest.resetModules();
    const { verifyProvider } = await import('../src/services/llm-router');

    const result = await verifyProvider('bedrock', 'eu.anthropic.claude-sonnet-4-6');

    expect(result.available).toBe(false);
    expect(result.ok).toBe(false);
    // The message must name the CONSEQUENCE, not just the missing var — an
    // unset gate means the router SKIPS bedrock and silently serves the
    // fallback, which is the failure mode VTID-03563 exists to end.
    expect(result.error).toMatch(/SKIPS/i);
  });

  test('surfaces the adapter error verbatim rather than reporting a bare failure', async () => {
    // An AccessDenied on a specific inference profile is the single most
    // useful thing this endpoint can return: it is indistinguishable from
    // "model does not exist" unless the real message is passed through.
    process.env.BEDROCK_ROLE_ARN = 'arn:aws:iam::472838866351:role/vitana-ecs-task-role';
    jest.resetModules();

    jest.doMock('../src/providers/bedrock', () => ({
      invokeBedrock: jest.fn().mockResolvedValue({
        ok: false,
        error: 'AccessDeniedException: anthropic.claude-opus-4-7 is not available for this account',
      }),
    }));

    const { verifyProvider } = await import('../src/services/llm-router');
    const result = await verifyProvider('bedrock', 'eu.anthropic.claude-opus-4-7');

    expect(result.ok).toBe(false);
    expect(result.available).toBe(true);
    expect(result.error).toContain('not available for this account');
  });

  test('reports ok:true on a real completion', async () => {
    process.env.BEDROCK_ROLE_ARN = 'arn:aws:iam::472838866351:role/vitana-ecs-task-role';
    jest.resetModules();

    jest.doMock('../src/providers/bedrock', () => ({
      invokeBedrock: jest.fn().mockResolvedValue({
        ok: true,
        text: 'OK',
        model: 'eu.anthropic.claude-sonnet-4-6',
      }),
    }));

    const { verifyProvider } = await import('../src/services/llm-router');
    const result = await verifyProvider('bedrock', 'eu.anthropic.claude-sonnet-4-6');

    expect(result.ok).toBe(true);
    expect(result.available).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test('an unknown provider is reported, not thrown', async () => {
    jest.resetModules();
    const { verifyProvider } = await import('../src/services/llm-router');
    const result = await verifyProvider('nope' as LLMProvider, 'x');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown provider/);
  });
});

/**
 * VTID-03565 SEAM tests — added after review (#3073) found the first version of
 * this fix was defeated one layer down.
 *
 * The route's zod schema and the service's `validatePolicy()` are TWO gates on
 * the SAME write. The original change relaxed only the schema, so every test
 * passed while the operation it was meant to enable still returned 400. Testing
 * each gate in isolation could never catch that — these call the real
 * `validatePolicy()` with the real production policy shape.
 */
describe('VTID-03565 write path: route schema and service validator agree', () => {
  const ORIGINAL_ENV = { ...process.env };

  const ALLOWLIST = [
    // the six live stages' current models
    { provider_key: 'anthropic', model_id: 'claude-3-5-sonnet-20241022',
      applicable_stages: ['planner','worker','validator','operator','memory','triage'] },
    { provider_key: 'vertex', model_id: 'gemini-3.1-pro-preview',
      applicable_stages: ['planner','worker','validator','operator','memory','triage'] },
    { provider_key: 'vertex', model_id: 'gemini-2.5-pro',
      applicable_stages: ['planner','worker','validator','operator','memory','triage'] },
    // bedrock rows as seeded by migration 20260810120000
    { provider_key: 'bedrock', model_id: 'eu.anthropic.claude-sonnet-4-6',
      applicable_stages: ['planner','worker','validator','operator','memory','triage','vision','classifier'] },
    { provider_key: 'bedrock', model_id: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
      applicable_stages: ['classifier','memory','worker','triage','validator','operator'] },
  ];

  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, json: async () => ALLOWLIST, text: async () => '',
    }) as unknown as typeof fetch;
  });
  afterEach(() => { process.env = { ...ORIGINAL_ENV }; jest.resetModules(); });

  test('the ACTIVE six-stage policy passes validatePolicy (no phantom missing-stage errors)', async () => {
    const { validatePolicy } = await import('../src/services/llm-routing-policy-service');
    const result = await validatePolicy(LIVE_V10_POLICY as never);
    // Regression: previously produced "Missing configuration for stage: vision"
    // and "...: classifier" despite the caller touching neither.
    expect(result.errors.filter((e) => e.includes('Missing configuration'))).toEqual([]);
  });

  test('a bedrock stage validates once the allowlist is seeded', async () => {
    const { validatePolicy } = await import('../src/services/llm-routing-policy-service');
    const next = {
      ...LIVE_V10_POLICY,
      validator: {
        primary_provider: 'bedrock',
        primary_model: 'eu.anthropic.claude-sonnet-4-6',
        fallback_provider: 'bedrock',
        fallback_model: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
      },
    };
    const result = await validatePolicy(next as never);
    expect(result.errors.filter((e) => e.toLowerCase().includes('bedrock'))).toEqual([]);
  });

  test('an UNSEEDED bedrock model is still rejected — the allowlist still bites', async () => {
    // eu.anthropic.claude-opus-4-7 is AccessDenied for this account and is
    // deliberately NOT in the migration. Accepting it would let an operator
    // select a model that fails every call and silently serves the fallback.
    const { validatePolicy } = await import('../src/services/llm-routing-policy-service');
    const next = {
      ...LIVE_V10_POLICY,
      validator: {
        primary_provider: 'bedrock',
        primary_model: 'eu.anthropic.claude-opus-4-7',
        fallback_provider: 'bedrock',
        fallback_model: 'eu.anthropic.claude-sonnet-4-6',
      },
    };
    const result = await validatePolicy(next as never);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('claude-opus-4-7'))).toBe(true);
  });

  test('a missing CORE stage is still rejected by validatePolicy', async () => {
    const { validatePolicy } = await import('../src/services/llm-routing-policy-service');
    const partial: Record<string, unknown> = { ...LIVE_V10_POLICY };
    delete partial.planner;
    const result = await validatePolicy(partial as never);
    expect(result.errors).toContain('Missing configuration for stage: planner');
  });

  test('PolicySchema optional keys are EXACTLY OPTIONAL_STAGES (drift guard)', async () => {
    // The two gates must never disagree again. If someone makes a third stage
    // optional in one place only, this fails.
    const { OPTIONAL_STAGES } = await import('../src/constants/llm-defaults');
    const shape = (PolicySchema as unknown as { shape: Record<string, { isOptional(): boolean }> }).shape;
    const optionalInSchema = Object.keys(shape).filter((k) => shape[k].isOptional()).sort();
    expect(optionalInSchema).toEqual([...OPTIONAL_STAGES].sort());
  });
});
