/**
 * AI Bridge route (Aurora migration B7) — Gemini-shaped facade over Bedrock.
 *
 * Pins three things:
 *   1. The route is auth-gated exactly like self-healing's /report
 *      (requireServiceOrAdmin) — no anonymous caller can spend Bedrock spend
 *      on this codebase's behalf.
 *   2. Request translation: a Gemini-shaped {messages, options, tools} body
 *      is correctly split into Bedrock's {system, messages, tools} shape —
 *      system-role turns pulled out, user/assistant turns preserved in order.
 *   3. Response translation: Bedrock's {text, toolCall} response becomes a
 *      Gemini-shaped {candidates:[{content:{parts:[...]}}]} body that
 *      vitana-v1's extractTextFromResponse/extractFunctionCall (which read
 *      exactly those paths) can consume unmodified.
 */

import express from 'express';
import request from 'supertest';

const mockInvokeBedrock = jest.fn();
jest.mock('../src/providers/bedrock', () => {
  const actual = jest.requireActual('../src/providers/bedrock');
  return {
    ...actual,
    invokeBedrock: (...args: unknown[]) => mockInvokeBedrock(...args),
  };
});

// Deterministic JWT path — every test here exercises the service-token leg,
// so the admin-JWT fallback should never even be reached.
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  optionalAuth: (_req: any, res: any, next: () => void) => next(),
}));

import aiBridgeRouter from '../src/routes/ai-bridge';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/ai-bridge', aiBridgeRouter);
  return app;
}

describe('POST /api/v1/ai-bridge/generate', () => {
  const ORIGINAL_TOKEN = process.env.GATEWAY_SERVICE_TOKEN;
  const ORIGINAL_MODEL = process.env.BEDROCK_MODEL_ID;

  beforeEach(() => {
    process.env.GATEWAY_SERVICE_TOKEN = 'test-service-token';
    mockInvokeBedrock.mockReset();
  });

  afterAll(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.GATEWAY_SERVICE_TOKEN;
    else process.env.GATEWAY_SERVICE_TOKEN = ORIGINAL_TOKEN;
    if (ORIGINAL_MODEL === undefined) delete process.env.BEDROCK_MODEL_ID;
    else process.env.BEDROCK_MODEL_ID = ORIGINAL_MODEL;
  });

  it('rejects a request with no auth (401), never calling Bedrock', async () => {
    const res = await request(buildApp())
      .post('/api/v1/ai-bridge/generate')
      .send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(401);
    expect(mockInvokeBedrock).not.toHaveBeenCalled();
  });

  it('rejects an empty/missing messages array (400), never calling Bedrock', async () => {
    const res = await request(buildApp())
      .post('/api/v1/ai-bridge/generate')
      .set('Authorization', 'Bearer test-service-token')
      .send({ messages: [] });
    expect(res.status).toBe(400);
    expect(mockInvokeBedrock).not.toHaveBeenCalled();
  });

  it('rejects a messages array containing only a system entry (400)', async () => {
    const res = await request(buildApp())
      .post('/api/v1/ai-bridge/generate')
      .set('Authorization', 'Bearer test-service-token')
      .send({ messages: [{ role: 'system', content: 'be nice' }] });
    expect(res.status).toBe(400);
    expect(mockInvokeBedrock).not.toHaveBeenCalled();
  });

  it('splits system turns out and forwards user/assistant turns in order', async () => {
    mockInvokeBedrock.mockResolvedValue({
      ok: true,
      text: 'hello there',
      model: 'eu.anthropic.claude-sonnet-4-6',
      upstream_ms: 12,
    });

    const res = await request(buildApp())
      .post('/api/v1/ai-bridge/generate')
      .set('Authorization', 'Bearer test-service-token')
      .send({
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'system', content: 'Never apologize.' },
          { role: 'user', content: 'Say hi' },
          { role: 'assistant', content: 'Hi.' },
          { role: 'user', content: 'Again' },
        ],
      });

    expect(res.status).toBe(200);
    expect(mockInvokeBedrock).toHaveBeenCalledTimes(1);
    const call = mockInvokeBedrock.mock.calls[0][0];
    expect(call.system).toBe('You are terse.\n\nNever apologize.');
    expect(call.messages).toEqual([
      { role: 'user', content: 'Say hi' },
      { role: 'assistant', content: 'Hi.' },
      { role: 'user', content: 'Again' },
    ]);
  });

  it('forwards options.model/temperature/maxOutputTokens, defaulting model when unset', async () => {
    mockInvokeBedrock.mockResolvedValue({ ok: true, text: 'x', model: 'm', upstream_ms: 1 });

    await request(buildApp())
      .post('/api/v1/ai-bridge/generate')
      .set('Authorization', 'Bearer test-service-token')
      .send({ messages: [{ role: 'user', content: 'hi' }] });

    let call = mockInvokeBedrock.mock.calls[0][0];
    expect(call.model).toBe('eu.anthropic.claude-sonnet-4-6');
    expect(call.max_tokens).toBeUndefined();
    expect(call.temperature).toBeUndefined();

    mockInvokeBedrock.mockClear();
    await request(buildApp())
      .post('/api/v1/ai-bridge/generate')
      .set('Authorization', 'Bearer test-service-token')
      .send({
        messages: [{ role: 'user', content: 'hi' }],
        options: { model: 'custom-model-id', temperature: 0.2, maxOutputTokens: 512 },
      });
    call = mockInvokeBedrock.mock.calls[0][0];
    expect(call.model).toBe('custom-model-id');
    expect(call.temperature).toBe(0.2);
    expect(call.max_tokens).toBe(512);
  });

  it('translates tool declarations into Bedrock input_schema shape', async () => {
    mockInvokeBedrock.mockResolvedValue({ ok: true, text: '', model: 'm', upstream_ms: 1 });

    await request(buildApp())
      .post('/api/v1/ai-bridge/generate')
      .set('Authorization', 'Bearer test-service-token')
      .send({
        messages: [{ role: 'user', content: 'search for cats' }],
        tools: [
          {
            name: 'search',
            description: 'Search the web',
            parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
          },
        ],
      });

    const call = mockInvokeBedrock.mock.calls[0][0];
    expect(call.tools).toEqual([
      {
        name: 'search',
        description: 'Search the web',
        input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      },
    ]);
  });

  it('returns a Gemini-shaped text response extractTextFromResponse can read', async () => {
    mockInvokeBedrock.mockResolvedValue({
      ok: true,
      text: 'the answer is 42',
      model: 'eu.anthropic.claude-sonnet-4-6',
      upstream_ms: 5,
    });

    const res = await request(buildApp())
      .post('/api/v1/ai-bridge/generate')
      .set('Authorization', 'Bearer test-service-token')
      .send({ messages: [{ role: 'user', content: 'what is the answer' }] });

    expect(res.status).toBe(200);
    expect(res.body.candidates[0].content.parts[0].text).toBe('the answer is 42');
  });

  it('returns a Gemini-shaped functionCall response extractFunctionCall can read', async () => {
    mockInvokeBedrock.mockResolvedValue({
      ok: true,
      text: '',
      toolCall: { name: 'search', arguments: { q: 'cats' } },
      model: 'eu.anthropic.claude-sonnet-4-6',
      upstream_ms: 5,
    });

    const res = await request(buildApp())
      .post('/api/v1/ai-bridge/generate')
      .set('Authorization', 'Bearer test-service-token')
      .send({ messages: [{ role: 'user', content: 'search for cats' }] });

    expect(res.status).toBe(200);
    expect(res.body.candidates[0].content.parts[0].functionCall).toEqual({
      name: 'search',
      args: { q: 'cats' },
    });
  });

  it('surfaces a not_configured Bedrock error as 502 without throwing', async () => {
    mockInvokeBedrock.mockResolvedValue({
      ok: false,
      error: 'not_configured',
      message: 'BEDROCK_ROLE_ARN env var not set',
    });

    const res = await request(buildApp())
      .post('/api/v1/ai-bridge/generate')
      .set('Authorization', 'Bearer test-service-token')
      .send({ messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      ok: false,
      error: 'not_configured',
      message: 'BEDROCK_ROLE_ARN env var not set',
    });
  });

  it('accepts the service token without ever invoking JWT validation', async () => {
    const authMock = jest.requireMock('../src/middleware/auth-supabase-jwt') as {
      optionalAuth: jest.Mock;
    };
    const spy = jest.fn((_req: any, _res: any, next: () => void) => next());
    (authMock as any).optionalAuth = spy;

    mockInvokeBedrock.mockResolvedValue({ ok: true, text: 'x', model: 'm', upstream_ms: 1 });
    const res = await request(buildApp())
      .post('/api/v1/ai-bridge/generate')
      .set('Authorization', 'Bearer test-service-token')
      .send({ messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });
});
