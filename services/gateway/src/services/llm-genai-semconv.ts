/**
 * VTID-04410 (Orchestrator v2, P7): OpenTelemetry GenAI semantic-convention
 * attributes for every `llm.call.*` OASIS event
 * (docs/ORCHESTRATOR-REDESIGN-PLAN.md §5, P7 "OTel GenAI spans → OASIS").
 *
 * Every router call already lands in OASIS as `llm.call.started` /
 * `.completed` / `.failed` with Vitana's own field names. This module adds
 * the same facts under the OpenTelemetry GenAI names, so a span exporter,
 * a trace viewer or an eval job can read them without a Vitana-specific
 * mapping. It is additive: no existing payload field is renamed or removed,
 * no new pipeline or collector is introduced, and nothing here does I/O.
 *
 * Deliberately NOT included: prompt or completion text. The payload already
 * stores only a prompt hash, and the GenAI content attributes are opt-in in
 * the spec for the same reason.
 */

import { createHash } from 'crypto';

export type GenAIEventPhase = 'started' | 'completed' | 'failed';

export interface GenAISpanInput {
  phase: GenAIEventPhase;
  traceId: string;
  provider: string;
  requestModel: string;
  responseModel?: string | null;
  service: string;
  stage: string;
  vtid?: string | null;
  threadId?: string | null;
  requestId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
  fallbackUsed?: boolean;
  errorCode?: string | null;
}

export type GenAIAttributeValue = string | number | boolean;

export interface GenAISpan {
  /** OTel span name, `{operation} {model}` per the GenAI conventions. */
  name: string;
  kind: 'CLIENT';
  /** 32 lowercase hex characters (W3C trace-context). */
  trace_id: string;
  /** 16 lowercase hex characters, stable for one call across its events. */
  span_id: string;
  status: 'UNSET' | 'OK' | 'ERROR';
  attributes: Record<string, GenAIAttributeValue>;
}

/**
 * Vitana provider key → `gen_ai.provider.name` well-known value. Unknown
 * providers pass through unchanged rather than being dropped, so a new
 * adapter is still attributable.
 */
export const GENAI_PROVIDER_NAMES: Record<string, string> = {
  bedrock: 'aws.bedrock',
  anthropic: 'anthropic',
  openai: 'openai',
  vertex: 'gcp.vertex_ai',
  deepseek: 'deepseek',
  claude_subscription: 'anthropic',
};

export const GENAI_OPERATION_NAME = 'chat';

export function genAIProviderName(provider: string): string {
  const key = (provider || '').trim().toLowerCase();
  return GENAI_PROVIDER_NAMES[key] ?? (key || 'unknown');
}

/** Normalise any trace id (a UUID today) to 32 hex characters. */
export function toOtelTraceId(traceId: string): string {
  const hex = (traceId || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length === 32 && !/^0+$/.test(hex)) return hex;
  return createHash('sha256').update(traceId || '').digest('hex').slice(0, 32);
}

/** One span per call: derived from the trace id, so all three events agree. */
export function toOtelSpanId(traceId: string): string {
  return createHash('sha256').update(`span:${traceId || ''}`).digest('hex').slice(0, 16);
}

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

export function buildGenAISpan(input: GenAISpanInput): GenAISpan {
  const requestModel = input.requestModel || 'unknown';
  const attributes: Record<string, GenAIAttributeValue> = {
    'gen_ai.operation.name': GENAI_OPERATION_NAME,
    'gen_ai.provider.name': genAIProviderName(input.provider),
    'gen_ai.request.model': requestModel,
    'vitana.llm.stage': input.stage,
    'vitana.llm.service': input.service,
  };

  if (input.phase !== 'started') {
    attributes['gen_ai.response.model'] = input.responseModel || requestModel;
    attributes['vitana.llm.fallback_used'] = input.fallbackUsed === true;
    if (isCount(input.latencyMs)) attributes['vitana.llm.latency_ms'] = input.latencyMs;
  }
  if (input.phase === 'completed') {
    if (isCount(input.inputTokens)) attributes['gen_ai.usage.input_tokens'] = input.inputTokens;
    if (isCount(input.outputTokens)) attributes['gen_ai.usage.output_tokens'] = input.outputTokens;
    if (input.requestId) attributes['gen_ai.response.id'] = input.requestId;
  }
  if (input.phase === 'failed') {
    attributes['error.type'] = input.errorCode || '_OTHER';
  }
  if (input.threadId) attributes['gen_ai.conversation.id'] = input.threadId;
  if (input.vtid) attributes['vitana.vtid'] = input.vtid;

  return {
    name: `${GENAI_OPERATION_NAME} ${requestModel}`,
    kind: 'CLIENT',
    trace_id: toOtelTraceId(input.traceId),
    span_id: toOtelSpanId(input.traceId),
    status: input.phase === 'failed' ? 'ERROR' : input.phase === 'completed' ? 'OK' : 'UNSET',
    attributes,
  };
}
