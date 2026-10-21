/**
 * VTID-03025: LiveKit hourly tests — Layer-A dry-run evaluator unit tests.
 *
 * `evaluateLiveKitDryRun()` lazily imports `routes/orb-live`,
 * `orb/live/instruction/live-system-instruction`, and `@google-cloud/vertexai`
 * — all three are mocked at the module boundary here so this suite never
 * drags in the real 14k-line orb-live.ts (see the file header comment in
 * the source for why) and never makes a real Vertex call.
 */

const mockGetSupabase = jest.fn();
jest.mock('../../../src/lib/supabase', () => ({
  getSupabase: (...args: unknown[]) => mockGetSupabase(...args),
}));

const mockBuildBootstrapContextPack = jest.fn();
const mockBuildLiveApiTools = jest.fn();
jest.mock('../../../src/routes/orb-live', () => ({
  buildBootstrapContextPack: (...args: unknown[]) => mockBuildBootstrapContextPack(...args),
  buildLiveApiTools: (...args: unknown[]) => mockBuildLiveApiTools(...args),
}));

const mockBuildLiveSystemInstruction = jest.fn();
jest.mock('../../../src/orb/live/instruction/live-system-instruction', () => ({
  buildLiveSystemInstruction: (...args: unknown[]) => mockBuildLiveSystemInstruction(...args),
}));

const mockGenerateContent = jest.fn();
const mockGetGenerativeModel = jest.fn(() => ({ generateContent: mockGenerateContent }));
const mockVertexAICtor = jest.fn(() => ({ getGenerativeModel: mockGetGenerativeModel }));
jest.mock('@google-cloud/vertexai', () => ({
  VertexAI: function VertexAI(this: unknown, ...args: unknown[]) {
    return mockVertexAICtor(...args);
  },
}));

import { evaluateLiveKitDryRun } from '../../../src/services/voice-lab/livekit-test-eval';

type IdRow = {
  user_id: string;
  tenant_id: string;
  active_role: string | null;
  app_users?: { email?: string | null; vitana_id?: string | null } | null;
};

/** Builds a `getSupabase()` stub for `user_tenants` identity resolution.
 *  Each call to `.maybeSingle()` (one per tier attempted) pops the next
 *  queued response, in order. */
function makeIdentitySupabase(responses: Array<{ data: IdRow | null; error?: unknown }>) {
  let idx = 0;
  const eqCalls: Array<[string, unknown]> = [];
  const notCalls: Array<[string, unknown, unknown]> = [];
  const from = jest.fn((_table: string) => {
    const chain: any = {
      select: jest.fn(() => chain),
      eq: jest.fn((col: string, val: unknown) => {
        eqCalls.push([col, val]);
        return chain;
      }),
      not: jest.fn((col: string, op: string, val: unknown) => {
        notCalls.push([col, op, val]);
        return chain;
      }),
      order: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      maybeSingle: jest.fn(() => {
        const r = responses[idx] ?? { data: null, error: null };
        idx += 1;
        return Promise.resolve(r);
      }),
    };
    return chain;
  });
  return { from, eqCalls, notCalls, callCount: () => idx };
}

function textPart(text: string) {
  return { text };
}
function fnPart(name: string, args: Record<string, unknown>) {
  return { functionCall: { name, args } };
}

function mockVertexResponse(parts: unknown[]) {
  mockGenerateContent.mockResolvedValue({
    response: { candidates: [{ content: { parts } }] },
  });
}

const savedEnv = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...savedEnv };
  process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
  delete process.env.GCP_PROJECT;
  delete process.env.VOICE_LAB_TEST_MODEL;
  delete process.env.VOICE_LAB_TEST_USER_ID;
  delete process.env.VOICE_LAB_TEST_TENANT_ID;
  delete process.env.VERTEX_MODEL;
  mockBuildBootstrapContextPack.mockResolvedValue({ contextInstruction: undefined, skippedReason: undefined });
  mockBuildLiveApiTools.mockReturnValue([{ function_declarations: [{ name: 'noop_tool' }] }]);
  mockBuildLiveSystemInstruction.mockReturnValue('SYSTEM INSTRUCTION TEXT');
  mockVertexResponse([textPart('ok')]);
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe('evaluateLiveKitDryRun — identity resolution', () => {
  it('skips Supabase entirely when a full identity (tenant_id + vitana_id + email) is supplied', async () => {
    const sb = makeIdentitySupabase([]);
    mockGetSupabase.mockReturnValue(sb);
    const result = await evaluateLiveKitDryRun({
      prompt: 'hi',
      identity: { user_id: 'u1', tenant_id: 't1', vitana_id: 'v1', email: 'e@x.com' },
    });
    expect(sb.from).not.toHaveBeenCalled();
    expect(result.resolved_identity).toEqual({
      user_id: 'u1',
      tenant_id: 't1',
      vitana_id: 'v1',
      email: 'e@x.com',
      active_role: undefined,
    });
  });

  it('resolves via tier 1 (user_tenants by user_id) when it hits on the first try', async () => {
    const sb = makeIdentitySupabase([
      { data: { user_id: 'u1', tenant_id: 'tenant-1', active_role: 'patient', app_users: { email: 'a@b.com', vitana_id: 'vid-1' } } },
    ]);
    mockGetSupabase.mockReturnValue(sb);
    const result = await evaluateLiveKitDryRun({ prompt: 'hi', identity: { user_id: 'u1' } });
    expect(sb.callCount()).toBe(1);
    expect(result.resolved_identity.tenant_id).toBe('tenant-1');
    expect(result.resolved_identity.vitana_id).toBe('vid-1');
    expect(result.resolved_identity.email).toBe('a@b.com');
    expect(sb.eqCalls).toContainEqual(['user_id', 'u1']);
  });

  it('does not overwrite a caller-supplied tenant_id even when tier 1 returns a different one', async () => {
    const sb = makeIdentitySupabase([
      { data: { user_id: 'u1', tenant_id: 'other-tenant', active_role: null, app_users: { email: 'a@b.com', vitana_id: 'vid-1' } } },
    ]);
    mockGetSupabase.mockReturnValue(sb);
    const result = await evaluateLiveKitDryRun({
      prompt: 'hi',
      identity: { user_id: 'u1', tenant_id: 'caller-tenant' },
    });
    expect(result.resolved_identity.tenant_id).toBe('caller-tenant');
    // still fills in the missing email/vitana_id from the DB row
    expect(result.resolved_identity.email).toBe('a@b.com');
  });

  it('falls through to tier 2 (canonical test email) when tier 1 misses', async () => {
    const sb = makeIdentitySupabase([
      { data: null },
      { data: { user_id: 'u2', tenant_id: 'tenant-2', active_role: null, app_users: { email: 'e2e-test@vitana.dev', vitana_id: 'vid-2' } } },
    ]);
    mockGetSupabase.mockReturnValue(sb);
    const result = await evaluateLiveKitDryRun({ prompt: 'hi' });
    expect(sb.callCount()).toBe(2);
    expect(result.resolved_identity.tenant_id).toBe('tenant-2');
    expect(sb.eqCalls).toContainEqual(['app_users.email', 'e2e-test@vitana.dev']);
    expect(sb.notCalls).toContainEqual(['app_users', 'is', null]);
  });

  it('falls through to tier 3 (oldest user with a vitana_id) when tiers 1 and 2 both miss', async () => {
    const sb = makeIdentitySupabase([
      { data: null },
      { data: null },
      { data: { user_id: 'u3', tenant_id: 'tenant-3', active_role: null, app_users: { email: null, vitana_id: 'vid-3' } } },
    ]);
    mockGetSupabase.mockReturnValue(sb);
    const result = await evaluateLiveKitDryRun({ prompt: 'hi' });
    expect(sb.callCount()).toBe(3);
    expect(result.resolved_identity.tenant_id).toBe('tenant-3');
    expect(sb.notCalls).toContainEqual(['app_users.vitana_id', 'is', null]);
  });

  it('throws a descriptive error when all three tiers miss and no tenant override is set', async () => {
    const sb = makeIdentitySupabase([{ data: null }, { data: null }, { data: null }]);
    mockGetSupabase.mockReturnValue(sb);
    await expect(evaluateLiveKitDryRun({ prompt: 'hi' })).rejects.toThrow(
      /no usable test identity/,
    );
  });

  it('VOICE_LAB_TEST_TENANT_ID env override prevents the "no usable identity" throw even if DB misses', async () => {
    const sb = makeIdentitySupabase([{ data: null }, { data: null }, { data: null }]);
    mockGetSupabase.mockReturnValue(sb);
    process.env.VOICE_LAB_TEST_TENANT_ID = 'env-tenant';
    const result = await evaluateLiveKitDryRun({ prompt: 'hi' });
    expect(result.resolved_identity.tenant_id).toBe('env-tenant');
  });
});

describe('evaluateLiveKitDryRun — prompt assembly + Vertex call shape', () => {
  function stubIdentity() {
    const sb = makeIdentitySupabase([
      { data: { user_id: 'u1', tenant_id: 't1', active_role: 'patient', app_users: { email: 'a@b.com', vitana_id: 'vid-1' } } },
    ]);
    mockGetSupabase.mockReturnValue(sb);
    return sb;
  }

  it('builds the system instruction with defaults and omitGreetingPolicy=true (mirrors prod LiveKit, VTID-03046)', async () => {
    stubIdentity();
    await evaluateLiveKitDryRun({ prompt: 'What is my next appointment?' });
    expect(mockBuildLiveSystemInstruction).toHaveBeenCalledWith(
      'en',
      'friendly, calm, empathetic',
      undefined,
      'patient',
      undefined,
      undefined,
      false,
      null,
      null,
      null,
      undefined,
      'vid-1',
      true,
    );
  });

  it('passes bootstrapResult.contextInstruction through and honors explicit language/voiceStyle/currentRoute', async () => {
    stubIdentity();
    mockBuildBootstrapContextPack.mockResolvedValue({ contextInstruction: 'CTX BLOCK', skippedReason: undefined });
    await evaluateLiveKitDryRun({
      prompt: 'hi',
      language: 'de',
      voiceStyle: 'crisp',
      currentRoute: '/wallet',
      activeRole: 'community',
    });
    expect(mockBuildLiveSystemInstruction).toHaveBeenCalledWith(
      'de',
      'crisp',
      'CTX BLOCK',
      'community',
      undefined,
      undefined,
      false,
      null,
      '/wallet',
      null,
      undefined,
      'vid-1',
      true,
    );
  });

  it('calls buildBootstrapContextPack with a voicelab-prefixed session id and the resolved identity', async () => {
    stubIdentity();
    await evaluateLiveKitDryRun({ prompt: 'hi' });
    expect(mockBuildBootstrapContextPack).toHaveBeenCalledTimes(1);
    const [supabaseIdentity, sessionId] = mockBuildBootstrapContextPack.mock.calls[0];
    expect(sessionId).toMatch(/^voicelab-test-/);
    expect(supabaseIdentity).toMatchObject({
      user_id: 'u1',
      tenant_id: 't1',
      email: 'a@b.com',
      vitana_id: 'vid-1',
      role: 'authenticated',
      exafy_admin: false,
    });
  });

  it('adds a bootstrap_skipped warning when the context pack reports a skippedReason, and omits warnings otherwise', async () => {
    stubIdentity();
    mockBuildBootstrapContextPack.mockResolvedValue({ contextInstruction: undefined, skippedReason: 'no_memory_configured' });
    const withWarning = await evaluateLiveKitDryRun({ prompt: 'hi' });
    expect(withWarning.warnings).toEqual(['bootstrap_skipped:no_memory_configured']);

    stubIdentity();
    mockBuildBootstrapContextPack.mockResolvedValue({ contextInstruction: undefined, skippedReason: undefined });
    const withoutWarning = await evaluateLiveKitDryRun({ prompt: 'hi' });
    expect(withoutWarning.warnings).toBeUndefined();
  });

  it('calls buildLiveApiTools with (authenticated, currentRoute, activeRole)', async () => {
    stubIdentity();
    await evaluateLiveKitDryRun({ prompt: 'hi', currentRoute: '/health', activeRole: 'staff' });
    expect(mockBuildLiveApiTools).toHaveBeenCalledWith('authenticated', '/health', 'staff');
  });

  it('adapts snake_case function_declarations tool wrappers into the Vertex SDK camelCase shape', async () => {
    stubIdentity();
    mockBuildLiveApiTools.mockReturnValue([
      { function_declarations: [{ name: 'tool_a' }, { name: 'tool_b' }] },
    ]);
    await evaluateLiveKitDryRun({ prompt: 'hi' });
    const modelOpts = mockGetGenerativeModel.mock.calls[0][0];
    expect(modelOpts.tools).toEqual([
      { functionDeclarations: [{ name: 'tool_a' }, { name: 'tool_b' }] },
    ]);
  });

  it('also accepts a catalog already in camelCase functionDeclarations shape (defensive branch)', async () => {
    stubIdentity();
    mockBuildLiveApiTools.mockReturnValue([
      { functionDeclarations: [{ name: 'tool_c' }] },
    ]);
    await evaluateLiveKitDryRun({ prompt: 'hi' });
    const modelOpts = mockGetGenerativeModel.mock.calls[0][0];
    expect(modelOpts.tools).toEqual([{ functionDeclarations: [{ name: 'tool_c' }] }]);
  });

  it('reports tool_count as the sum of functionDeclarations across all wrappers', async () => {
    stubIdentity();
    mockBuildLiveApiTools.mockReturnValue([
      { function_declarations: [{ name: 'a' }, { name: 'b' }] },
      { function_declarations: [{ name: 'c' }] },
    ]);
    const result = await evaluateLiveKitDryRun({ prompt: 'hi' });
    expect(result.tool_count).toBe(3);
  });

  it('sends generateContent with the prompt as a single user turn', async () => {
    stubIdentity();
    await evaluateLiveKitDryRun({ prompt: 'Book me a slot tomorrow' });
    expect(mockGenerateContent).toHaveBeenCalledWith({
      contents: [{ role: 'user', parts: [{ text: 'Book me a slot tomorrow' }] }],
    });
  });

  it('instruction_chars reflects the exact length of the assembled system instruction', async () => {
    stubIdentity();
    mockBuildLiveSystemInstruction.mockReturnValue('12345678901234567890'); // 20 chars
    const result = await evaluateLiveKitDryRun({ prompt: 'hi' });
    expect(result.instruction_chars).toBe(20);
  });

  it('throws when no GCP project id is configured (neither GOOGLE_CLOUD_PROJECT nor GCP_PROJECT)', async () => {
    stubIdentity();
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCP_PROJECT;
    await expect(evaluateLiveKitDryRun({ prompt: 'hi' })).rejects.toThrow(/GOOGLE_CLOUD_PROJECT not set/);
  });

  describe('model resolution priority', () => {
    it('explicit input.model wins over every env var', async () => {
      stubIdentity();
      process.env.VOICE_LAB_TEST_MODEL = 'env-model';
      process.env.VERTEX_MODEL = 'vertex-env-model';
      const result = await evaluateLiveKitDryRun({ prompt: 'hi', model: 'explicit-model' });
      expect(result.model).toBe('explicit-model');
      expect(mockGetGenerativeModel.mock.calls[0][0].model).toBe('explicit-model');
    });

    it('VOICE_LAB_TEST_MODEL wins over VERTEX_MODEL when input.model is absent', async () => {
      stubIdentity();
      process.env.VOICE_LAB_TEST_MODEL = 'env-model';
      process.env.VERTEX_MODEL = 'vertex-env-model';
      const result = await evaluateLiveKitDryRun({ prompt: 'hi' });
      expect(result.model).toBe('env-model');
    });

    it('VERTEX_MODEL is used when neither input.model nor VOICE_LAB_TEST_MODEL is set', async () => {
      stubIdentity();
      process.env.VERTEX_MODEL = 'vertex-env-model';
      const result = await evaluateLiveKitDryRun({ prompt: 'hi' });
      expect(result.model).toBe('vertex-env-model');
    });

    it('falls back to gemini-2.5-pro when nothing is configured', async () => {
      stubIdentity();
      const result = await evaluateLiveKitDryRun({ prompt: 'hi' });
      expect(result.model).toBe('gemini-2.5-pro');
    });
  });
});

describe('evaluateLiveKitDryRun — response parsing', () => {
  function stubIdentity() {
    mockGetSupabase.mockReturnValue(
      makeIdentitySupabase([
        { data: { user_id: 'u1', tenant_id: 't1', active_role: 'patient', app_users: { email: 'a@b.com', vitana_id: 'vid-1' } } },
      ]),
    );
  }

  it('captures function-call parts as tool_calls with name + args', async () => {
    stubIdentity();
    mockVertexResponse([
      fnPart('navigate_to', { route: '/wallet' }),
      fnPart('search_products', { query: 'omega-3' }),
    ]);
    const result = await evaluateLiveKitDryRun({ prompt: 'hi' });
    expect(result.tool_calls).toEqual([
      { name: 'navigate_to', args: { route: '/wallet' } },
      { name: 'search_products', args: { query: 'omega-3' } },
    ]);
    expect(result.reply_text).toBe('');
  });

  it('defaults args to {} when the model omits them on a function call', async () => {
    stubIdentity();
    mockVertexResponse([{ functionCall: { name: 'ping' } }]);
    const result = await evaluateLiveKitDryRun({ prompt: 'hi' });
    expect(result.tool_calls).toEqual([{ name: 'ping', args: {} }]);
  });

  it('concatenates and trims text parts into reply_text when no tool fires', async () => {
    stubIdentity();
    mockVertexResponse([textPart('Hello '), textPart('there!')]);
    const result = await evaluateLiveKitDryRun({ prompt: 'hi' });
    expect(result.tool_calls).toEqual([]);
    expect(result.reply_text).toBe('Hello there!');
  });

  it('handles a response with no candidates as empty tool_calls + empty reply_text (does not throw)', async () => {
    stubIdentity();
    mockGenerateContent.mockResolvedValue({ response: { candidates: [] } });
    const result = await evaluateLiveKitDryRun({ prompt: 'hi' });
    expect(result.tool_calls).toEqual([]);
    expect(result.reply_text).toBe('');
  });

  it('reports a non-negative numeric latency_ms', async () => {
    stubIdentity();
    const result = await evaluateLiveKitDryRun({ prompt: 'hi' });
    expect(typeof result.latency_ms).toBe('number');
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });
});
