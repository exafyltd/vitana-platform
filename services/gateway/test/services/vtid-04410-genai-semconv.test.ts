/**
 * VTID-04410: OpenTelemetry GenAI attributes on llm.call.* events.
 */
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

import { emitOasisEvent } from '../../src/services/oasis-event-service';
import {
  buildGenAISpan,
  genAIProviderName,
  toOtelSpanId,
  toOtelTraceId,
} from '../../src/services/llm-genai-semconv';
import { completeLLMCall, failLLMCall, startLLMCall } from '../../src/services/llm-telemetry-service';

const emit = emitOasisEvent as jest.Mock;
const payloadOf = (i: number) => emit.mock.calls[i][0].payload;

describe('VTID-04410 GenAI semantic-convention mapper', () => {
  test('AC-1: provider keys map to gen_ai.provider.name well-known values', () => {
    expect(genAIProviderName('bedrock')).toBe('aws.bedrock');
    expect(genAIProviderName('vertex')).toBe('gcp.vertex_ai');
    expect(genAIProviderName('deepseek')).toBe('deepseek');
    expect(genAIProviderName('anthropic')).toBe('anthropic');
    expect(genAIProviderName('NewThing')).toBe('newthing');
    expect(genAIProviderName('')).toBe('unknown');
  });

  test('AC-2: trace id is 32 hex (UUID dashes stripped), span id 16 hex and stable', () => {
    const uuid = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    expect(toOtelTraceId(uuid)).toBe('3f2a1b4c5d6e4f708a9b0c1d2e3f4a5b');
    expect(toOtelTraceId('not-a-uuid')).toMatch(/^[0-9a-f]{32}$/);
    expect(toOtelTraceId('00000000-0000-0000-0000-000000000000')).not.toMatch(/^0+$/);
    expect(toOtelSpanId(uuid)).toMatch(/^[0-9a-f]{16}$/);
    expect(toOtelSpanId(uuid)).toBe(toOtelSpanId(uuid));
  });

  test('AC-3: completed span carries usage, response model, OK status and no content', () => {
    const span = buildGenAISpan({
      phase: 'completed', traceId: 't', provider: 'bedrock', requestModel: 'eu.anthropic.claude-sonnet-4-6',
      service: 'operator', stage: 'operator', vtid: 'VTID-04410', threadId: 'th-1', requestId: 'req-9',
      inputTokens: 120, outputTokens: 40, latencyMs: 812, fallbackUsed: false,
    });
    expect(span.name).toBe('chat eu.anthropic.claude-sonnet-4-6');
    expect(span.kind).toBe('CLIENT');
    expect(span.status).toBe('OK');
    expect(span.attributes).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'aws.bedrock',
      'gen_ai.request.model': 'eu.anthropic.claude-sonnet-4-6',
      'gen_ai.response.model': 'eu.anthropic.claude-sonnet-4-6',
      'gen_ai.response.id': 'req-9',
      'gen_ai.usage.input_tokens': 120,
      'gen_ai.usage.output_tokens': 40,
      'gen_ai.conversation.id': 'th-1',
      'vitana.llm.stage': 'operator',
      'vitana.llm.service': 'operator',
      'vitana.llm.fallback_used': false,
      'vitana.llm.latency_ms': 812,
      'vitana.vtid': 'VTID-04410',
    });
    expect(JSON.stringify(span)).not.toMatch(/prompt|completion|content/);
  });

  test('AC-4: failed span is ERROR with error.type; started span is UNSET without usage', () => {
    const failed = buildGenAISpan({
      phase: 'failed', traceId: 't', provider: 'deepseek', requestModel: 'deepseek-flash',
      service: 's', stage: 'worker', errorCode: 'provider_error',
    });
    expect(failed.status).toBe('ERROR');
    expect(failed.attributes['error.type']).toBe('provider_error');
    expect(buildGenAISpan({ phase: 'failed', traceId: 't', provider: 'x', requestModel: 'm', service: 's', stage: 'worker' })
      .attributes['error.type']).toBe('_OTHER');

    const started = buildGenAISpan({ phase: 'started', traceId: 't', provider: 'bedrock', requestModel: 'm', service: 's', stage: 'planner' });
    expect(started.status).toBe('UNSET');
    expect(started.attributes['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(started.attributes['gen_ai.response.model']).toBeUndefined();
    expect(started.attributes['vitana.vtid']).toBeUndefined();
  });
});

describe('VTID-04410 llm.call.* payloads carry the span', () => {
  beforeEach(() => emit.mockClear());

  test('AC-5: started/completed/failed share one trace and span id; existing fields unchanged', async () => {
    const ctx = await startLLMCall({
      vtid: 'VTID-04410', service: 'operator', stage: 'operator', provider: 'deepseek', model: 'deepseek-flash', prompt: 'hi',
    });
    await completeLLMCall(ctx, { inputTokens: 10, outputTokens: 5 });
    await failLLMCall(ctx, { code: 'provider_error', message: 'boom' });

    const [p0, p1, p2] = [payloadOf(0), payloadOf(1), payloadOf(2)];
    expect(emit.mock.calls.map((c) => c[0].type)).toEqual(['llm.call.started', 'llm.call.completed', 'llm.call.failed']);
    for (const p of [p0, p1, p2]) {
      expect(p.otel.trace_id).toBe(toOtelTraceId(ctx.traceId));
      expect(p.otel.span_id).toBe(toOtelSpanId(ctx.traceId));
      expect(p.otel.attributes['gen_ai.provider.name']).toBe('deepseek');
    }
    expect(p0.otel.status).toBe('UNSET');
    expect(p1.otel.status).toBe('OK');
    expect(p1.otel.attributes['gen_ai.usage.input_tokens']).toBe(10);
    expect(p2.otel.status).toBe('ERROR');
    // Vitana's own fields are still there, untouched.
    expect(p1).toMatchObject({ provider: 'deepseek', model: 'deepseek-flash', input_tokens: 10, output_tokens: 5, trace_id: ctx.traceId });
    expect(p2).toMatchObject({ error_code: 'provider_error', error_message: 'boom' });
  });

  test('AC-6: a fallback reports the serving model as gen_ai.response.model', async () => {
    const ctx = await startLLMCall({
      vtid: null, service: 'x', stage: 'worker', provider: 'bedrock', model: 'primary-model', prompt: 'p',
    });
    await completeLLMCall(ctx, { fallbackUsed: true, fallbackTo: 'fallback-model' });
    const span = payloadOf(1).otel;
    expect(span.attributes['gen_ai.request.model']).toBe('primary-model');
    expect(span.attributes['gen_ai.response.model']).toBe('fallback-model');
    expect(span.attributes['vitana.llm.fallback_used']).toBe(true);
    expect(span.attributes['vitana.vtid']).toBeUndefined();
  });
});
