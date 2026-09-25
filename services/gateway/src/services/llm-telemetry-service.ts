/**
 * VTID-01208: LLM Telemetry Service
 *
 * Handles emission and querying of LLM telemetry events.
 * This is the canonical service for all LLM call telemetry.
 *
 * Features:
 * - Emit llm.call.started/completed/failed events
 * - Query LLM telemetry with filters
 * - Cost estimation
 * - Prompt hashing (no raw prompts stored)
 */

import { randomUUID, createHash } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import type { CicdOasisEvent } from '../types/cicd';
import { buildGenAISpan } from './llm-genai-semconv';
import { estimateCost } from '../constants/llm-defaults';
import { VITANA_ENV } from '../env';
import {
  LLMStage,
  LLMProvider,
  WorkerDomain,
  LLMTelemetryPayload,
  LLMCallEventType,
  TelemetryQueryParams,
  TelemetryQueryResponse,
  LLM_TELEMETRY_EVENT_TYPES,
} from '../types/llm-telemetry';

/**
 * Hash a prompt for audit purposes (no raw prompts stored)
 */
export function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').substring(0, 16);
}

/**
 * Generate a trace ID for correlation
 */
export function generateTraceId(): string {
  return randomUUID();
}

/**
 * LLM Call Context - passed through the call lifecycle
 */
export interface LLMCallContext {
  traceId: string;
  vtid: string | null;
  threadId?: string;
  service: string;
  stage: LLMStage;
  domain?: WorkerDomain;
  provider: LLMProvider | string;
  model: string;
  promptHash: string;
  agentConfigVersion?: string;
  startTime: number;
}

/**
 * Start an LLM call - emits llm.call.started event
 */
export interface StartLLMCallParams {
  vtid: string | null;
  threadId?: string;
  service: string;
  stage: LLMStage;
  domain?: WorkerDomain;
  provider: LLMProvider | string;
  model: string;
  prompt: string;
  agentConfigVersion?: string;
}

/**
 * VTID-04546: pure builder for the llm.call.started event. Produces exactly
 * the context + event `startLLMCall` has always emitted; split out so the
 * router can emit it without awaiting the insert.
 */
export function buildLLMCallStarted(params: StartLLMCallParams): {
  context: LLMCallContext;
  event: CicdOasisEvent;
} {
  const traceId = generateTraceId();
  const promptHash = hashPrompt(params.prompt);
  const startTime = Date.now();

  const context: LLMCallContext = {
    traceId,
    vtid: params.vtid,
    threadId: params.threadId,
    service: params.service,
    stage: params.stage,
    domain: params.domain,
    provider: params.provider,
    model: params.model,
    promptHash,
    agentConfigVersion: params.agentConfigVersion,
    startTime,
  };

  const payload: LLMTelemetryPayload = {
    vtid: params.vtid,
    thread_id: params.threadId,
    service: params.service,
    stage: params.stage,
    domain: params.domain,
    provider: params.provider,
    model: params.model,
    fallback_used: false,
    trace_id: traceId,
    latency_ms: 0,
    prompt_hash: promptHash,
    agent_config_version: params.agentConfigVersion,
    created_at: new Date().toISOString(),
    otel: buildGenAISpan({
      phase: 'started',
      traceId,
      provider: params.provider,
      requestModel: params.model,
      service: params.service,
      stage: params.stage,
      vtid: params.vtid,
      threadId: params.threadId,
    }),
  };

  return {
    context,
    event: {
      vtid: params.vtid || 'VTID-01208',
      type: 'llm.call.started',
      source: params.service,
      status: 'info',
      message: `LLM call started: ${params.stage} using ${params.provider}/${params.model}`,
      payload: payload as unknown as Record<string, unknown>,
    },
  };
}

/**
 * Start an LLM call - emits llm.call.started event (awaited).
 */
export async function startLLMCall(params: StartLLMCallParams): Promise<LLMCallContext> {
  const { context, event } = buildLLMCallStarted(params);
  await emitOasisEvent(event);
  return context;
}

/**
 * Complete an LLM call - emits llm.call.completed event
 */
export interface CompleteLLMCallResult {
  inputTokens?: number;
  outputTokens?: number;
  requestId?: string;
  fallbackUsed?: boolean;
  fallbackFrom?: string;
  fallbackTo?: string;
  retryCount?: number;
}

/**
 * VTID-04546: pure builder for the llm.call.completed event. Latency, cost
 * and created_at are all captured at the moment this is called, so an
 * emission that happens later still carries the same payload.
 */
export function buildLLMCallCompleted(
  context: LLMCallContext,
  result: CompleteLLMCallResult
): CicdOasisEvent {
  const latencyMs = Date.now() - context.startTime;

  const costEstimate = result.inputTokens && result.outputTokens
    ? estimateCost(
        result.fallbackUsed && result.fallbackTo ? result.fallbackTo : context.model,
        result.inputTokens,
        result.outputTokens
      )
    : undefined;

  const payload: LLMTelemetryPayload = {
    vtid: context.vtid,
    thread_id: context.threadId,
    service: context.service,
    stage: context.stage,
    domain: context.domain,
    provider: context.provider,
    model: result.fallbackUsed && result.fallbackTo ? result.fallbackTo : context.model,
    fallback_used: result.fallbackUsed ?? false,
    fallback_from: result.fallbackFrom,
    fallback_to: result.fallbackTo,
    retry_count: result.retryCount,
    request_id: result.requestId,
    trace_id: context.traceId,
    latency_ms: latencyMs,
    input_tokens: result.inputTokens,
    output_tokens: result.outputTokens,
    cost_estimate_usd: costEstimate,
    agent_config_version: context.agentConfigVersion,
    prompt_hash: context.promptHash,
    created_at: new Date().toISOString(),
    otel: buildGenAISpan({
      phase: 'completed',
      traceId: context.traceId,
      provider: context.provider,
      requestModel: context.model,
      responseModel: result.fallbackUsed && result.fallbackTo ? result.fallbackTo : context.model,
      service: context.service,
      stage: context.stage,
      vtid: context.vtid,
      threadId: context.threadId,
      requestId: result.requestId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs,
      fallbackUsed: result.fallbackUsed,
    }),
  };

  return {
    vtid: context.vtid || 'VTID-01208',
    type: 'llm.call.completed',
    source: context.service,
    status: 'success',
    message: `LLM call completed: ${context.stage} in ${latencyMs}ms${result.fallbackUsed ? ' (fallback)' : ''}`,
    payload: payload as unknown as Record<string, unknown>,
  };
}

/**
 * Complete an LLM call - emits llm.call.completed event (awaited).
 */
export async function completeLLMCall(
  context: LLMCallContext,
  result: CompleteLLMCallResult
): Promise<void> {
  await emitOasisEvent(buildLLMCallCompleted(context, result));
}

/**
 * Fail an LLM call - emits llm.call.failed event
 */
export interface FailLLMCallError {
  code?: string;
  message: string;
  retryCount?: number;
  fallbackUsed?: boolean;
  fallbackFrom?: string;
  fallbackTo?: string;
}

/**
 * VTID-04546: pure builder for the llm.call.failed event (see
 * buildLLMCallCompleted — values captured at call time).
 */
export function buildLLMCallFailed(
  context: LLMCallContext,
  error: FailLLMCallError
): CicdOasisEvent {
  const latencyMs = Date.now() - context.startTime;

  const payload: LLMTelemetryPayload = {
    vtid: context.vtid,
    thread_id: context.threadId,
    service: context.service,
    stage: context.stage,
    domain: context.domain,
    provider: context.provider,
    model: error.fallbackUsed && error.fallbackTo ? error.fallbackTo : context.model,
    fallback_used: error.fallbackUsed ?? false,
    fallback_from: error.fallbackFrom,
    fallback_to: error.fallbackTo,
    retry_count: error.retryCount,
    trace_id: context.traceId,
    latency_ms: latencyMs,
    agent_config_version: context.agentConfigVersion,
    prompt_hash: context.promptHash,
    error_code: error.code,
    error_message: error.message,
    created_at: new Date().toISOString(),
    otel: buildGenAISpan({
      phase: 'failed',
      traceId: context.traceId,
      provider: context.provider,
      requestModel: context.model,
      responseModel: error.fallbackUsed && error.fallbackTo ? error.fallbackTo : context.model,
      service: context.service,
      stage: context.stage,
      vtid: context.vtid,
      threadId: context.threadId,
      latencyMs,
      fallbackUsed: error.fallbackUsed,
      errorCode: error.code,
    }),
  };

  return {
    vtid: context.vtid || 'VTID-01208',
    type: 'llm.call.failed',
    source: context.service,
    status: 'error',
    message: `LLM call failed: ${context.stage} - ${error.message}`,
    payload: payload as unknown as Record<string, unknown>,
  };
}

/**
 * Fail an LLM call - emits llm.call.failed event (awaited).
 */
export async function failLLMCall(
  context: LLMCallContext,
  error: FailLLMCallError
): Promise<void> {
  await emitOasisEvent(buildLLMCallFailed(context, error));
}

// =============================================================================
// VTID-04546: detached (non-blocking) emission for latency-sensitive callers.
//
// The LLM router used to AWAIT the llm.call.started insert before the provider
// call and the llm.call.completed insert after it. Each is a Supabase POST
// with no timeout, so a slow oasis_events write added its full latency to
// every routed LLM call — on the voice cascade, directly to the time before
// the member hears a reply.
//
// These variants build the event synchronously (same payload, values captured
// at the same moment as before) and emit it in the background:
//   * Nothing is awaited on the caller's path.
//   * The started insert is always ISSUED before the completed/failed insert
//     of the same call: the terminal event is chained after the started emit
//     settles, so the ledger ordering is unchanged.
//   * Correlation needs no returned row: trace_id is generated client-side
//     (randomUUID) and carried on the context, exactly as before.
//   * No error ever reaches the caller; failures are logged.
// =============================================================================

const startedEmits = new WeakMap<LLMCallContext, Promise<void>>();

function emitDetached(event: CicdOasisEvent): Promise<void> {
  let p: Promise<unknown>;
  try {
    p = emitOasisEvent(event);
  } catch (err) {
    p = Promise.reject(err);
  }
  return p.then(
    () => undefined,
    (err) => {
      console.warn(
        `[LLM Telemetry] non-blocking ${event.type} emit failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  );
}

/**
 * Non-blocking twin of startLLMCall. Returns the context synchronously; the
 * llm.call.started insert runs in the background.
 */
export function startLLMCallDetached(params: StartLLMCallParams): LLMCallContext {
  let built: { context: LLMCallContext; event: CicdOasisEvent };
  try {
    built = buildLLMCallStarted(params);
  } catch (err) {
    console.warn(
      `[LLM Telemetry] could not build llm.call.started: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      traceId: generateTraceId(),
      vtid: params.vtid,
      threadId: params.threadId,
      service: params.service,
      stage: params.stage,
      domain: params.domain,
      provider: params.provider,
      model: params.model,
      promptHash: '',
      agentConfigVersion: params.agentConfigVersion,
      startTime: Date.now(),
    };
  }
  startedEmits.set(built.context, emitDetached(built.event));
  return built.context;
}

function chainAfterStarted(context: LLMCallContext, build: () => CicdOasisEvent): Promise<void> {
  let event: CicdOasisEvent;
  try {
    event = build();
  } catch (err) {
    console.warn(
      `[LLM Telemetry] could not build terminal event: ${err instanceof Error ? err.message : String(err)}`,
    );
    return Promise.resolve();
  }
  const after = startedEmits.get(context) ?? Promise.resolve();
  return after.then(() => emitDetached(event));
}

/**
 * Non-blocking twin of completeLLMCall. The payload (latency, cost,
 * created_at) is captured now; the insert is issued after the call's
 * started insert has settled. The returned promise never rejects and is
 * only for tests — production callers do not await it.
 */
export function completeLLMCallDetached(
  context: LLMCallContext,
  result: CompleteLLMCallResult
): Promise<void> {
  return chainAfterStarted(context, () => buildLLMCallCompleted(context, result));
}

/**
 * Non-blocking twin of failLLMCall (same contract as completeLLMCallDetached).
 */
export function failLLMCallDetached(
  context: LLMCallContext,
  error: FailLLMCallError
): Promise<void> {
  return chainAfterStarted(context, () => buildLLMCallFailed(context, error));
}

/**
 * Wrapper function for LLM calls with automatic telemetry
 *
 * Usage:
 * const result = await withLLMTelemetry(
 *   { vtid, service: 'gemini-operator', stage: 'operator', provider: 'vertex', model: 'gemini-2.5-pro', prompt },
 *   async (context) => {
 *     // Make actual LLM call
 *     const response = await llmClient.call(prompt);
 *     return {
 *       result: response,
 *       inputTokens: response.usage.input_tokens,
 *       outputTokens: response.usage.output_tokens,
 *     };
 *   }
 * );
 */
export async function withLLMTelemetry<T>(
  params: {
    vtid: string | null;
    threadId?: string;
    service: string;
    stage: LLMStage;
    domain?: WorkerDomain;
    provider: LLMProvider | string;
    model: string;
    prompt: string;
    agentConfigVersion?: string;
    fallbackProvider?: LLMProvider | string;
    fallbackModel?: string;
  },
  fn: (context: LLMCallContext) => Promise<{
    result: T;
    inputTokens?: number;
    outputTokens?: number;
    requestId?: string;
  }>
): Promise<T> {
  const context = await startLLMCall(params);

  try {
    const { result, inputTokens, outputTokens, requestId } = await fn(context);

    await completeLLMCall(context, {
      inputTokens,
      outputTokens,
      requestId,
      fallbackUsed: false,
    });

    return result;
  } catch (primaryError) {
    // If fallback is configured, try it
    if (params.fallbackProvider && params.fallbackModel) {
      console.log(`[LLM Telemetry] Primary ${params.provider}/${params.model} failed, trying fallback ${params.fallbackProvider}/${params.fallbackModel}`);

      try {
        const fallbackContext: LLMCallContext = {
          ...context,
          provider: params.fallbackProvider,
          model: params.fallbackModel,
          startTime: Date.now(),
        };

        const { result, inputTokens, outputTokens, requestId } = await fn(fallbackContext);

        await completeLLMCall(context, {
          inputTokens,
          outputTokens,
          requestId,
          fallbackUsed: true,
          fallbackFrom: params.model,
          fallbackTo: params.fallbackModel,
        });

        return result;
      } catch (fallbackError) {
        const errorMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        await failLLMCall(context, {
          code: 'FALLBACK_FAILED',
          message: `Primary and fallback both failed: ${errorMessage}`,
          fallbackUsed: true,
          fallbackFrom: params.model,
          fallbackTo: params.fallbackModel,
        });
        throw fallbackError;
      }
    }

    // No fallback, emit failure
    const errorMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
    await failLLMCall(context, {
      code: 'PRIMARY_FAILED',
      message: errorMessage,
    });
    throw primaryError;
  }
}

/**
 * Query LLM telemetry events from OASIS
 */
export async function queryLLMTelemetry(
  params: TelemetryQueryParams
): Promise<TelemetryQueryResponse> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.error('[LLM Telemetry] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE');
    return {
      ok: false,
      events: [],
      pagination: { limit: params.limit || 50, offset: params.offset || 0, total: 0, has_more: false },
      error: 'Gateway misconfigured: missing Supabase credentials',
    };
  }

  try {
    const limit = Math.min(params.limit || 50, 200);
    const offset = params.offset || 0;

    // Build query for llm.call.* events
    const eventTypesFilter = LLM_TELEMETRY_EVENT_TYPES.map(t => `topic.eq.${t}`).join(',');
    let queryUrl = `${supabaseUrl}/rest/v1/oasis_events?or=(${eventTypesFilter})&order=created_at.desc&limit=${limit + 1}&offset=${offset}`;

    // Add filters
    const filters: string[] = [];

    if (params.vtid) {
      filters.push(`vtid.eq.${params.vtid}`);
    }
    if (params.service) {
      filters.push(`service.eq.${params.service}`);
    }
    if (params.status === 'success') {
      filters.push(`topic.eq.llm.call.completed`);
    } else if (params.status === 'error') {
      filters.push(`topic.eq.llm.call.failed`);
    }
    if (params.since) {
      filters.push(`created_at.gte.${params.since}`);
    }
    if (params.until) {
      filters.push(`created_at.lte.${params.until}`);
    }

    if (filters.length > 0) {
      queryUrl += `&${filters.join('&')}`;
    }

    const response = await fetch(queryUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[LLM Telemetry] Query failed: ${response.status} - ${errorText}`);
      return {
        ok: false,
        events: [],
        pagination: { limit, offset, total: 0, has_more: false },
        error: `Query failed: ${response.status}`,
      };
    }

    const rawEvents = await response.json() as any[];
    const hasMore = rawEvents.length > limit;
    const events = rawEvents.slice(0, limit);

    // Transform to LLMTelemetryPayload and apply additional filters
    let telemetryEvents: LLMTelemetryPayload[] = events
      .map((ev: any) => ev.metadata as LLMTelemetryPayload)
      .filter((payload: LLMTelemetryPayload) => {
        if (params.stage && payload.stage !== params.stage) return false;
        if (params.provider && payload.provider !== params.provider) return false;
        if (params.model && payload.model !== params.model) return false;
        return true;
      });

    console.log(`[LLM Telemetry] Query returned ${telemetryEvents.length} events`);

    return {
      ok: true,
      events: telemetryEvents,
      pagination: {
        limit,
        offset,
        total: telemetryEvents.length,
        has_more: hasMore,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[LLM Telemetry] Query error: ${errorMessage}`);
    return {
      ok: false,
      events: [],
      pagination: { limit: params.limit || 50, offset: params.offset || 0, total: 0, has_more: false },
      error: errorMessage,
    };
  }
}

/**
 * A single (hour, provider) bucket in the summary's hourly trend.
 */
export interface LLMTelemetrySummaryHourlyBucket {
  hour: string;
  provider: string;
  calls: number;
}

/** Per-provider / per-service / per-stage breakdown row shapes. */
export interface LLMTelemetrySummaryProviderRow {
  provider: string;
  calls: number;
  completed: number;
  failed: number;
  fallback: number;
  cost_usd: number;
}
export interface LLMTelemetrySummaryBreakdownRow {
  calls: number;
  failed: number;
  service?: string;
  stage?: string;
}

export interface LLMTelemetrySummary {
  window_hours: number;
  /** VTID-03599: which VITANA_ENV this summary was scoped to (staging/production share oasis_events). */
  env: string;
  since: string;
  generated_at: string;
  total_started: number;
  total_completed: number;
  total_failed: number;
  total_fallback: number;
  total_cost_usd: number;
  /**
   * VTID-03599: named on purpose, not left for the caller to derive from
   * by_provider. This is the exact number that should be zero -- any
   * `anthropic` call 400s on a dead credit balance, any `vertex` call is the
   * Google line VTID-03579/03563 exist to kill. Non-zero means a stage is
   * routing somewhere it never should be.
   */
  non_bedrock_google_or_anthropic_calls: number;
  by_provider: LLMTelemetrySummaryProviderRow[];
  by_service: LLMTelemetrySummaryBreakdownRow[];
  by_stage: LLMTelemetrySummaryBreakdownRow[];
  hourly: LLMTelemetrySummaryHourlyBucket[];
}

export interface LLMTelemetrySummaryResponse {
  ok: boolean;
  summary: LLMTelemetrySummary | null;
  error?: string;
}

/**
 * VTID-03599: aggregate LLM call volume for the Command Hub "Usage Summary"
 * panel, via the `llm_telemetry_summary` SECURITY DEFINER RPC (migration
 * 20260811210000). Direct follow-up to VTID-03579/03563 -- routing tables
 * and per-call telemetry already existed, but nothing ever aggregated them,
 * which is exactly how a 268-call credit-balance leak and a 990-call
 * runaway planner loop both went unnoticed until someone read a bill.
 *
 * Always scopes to THIS gateway's own VITANA_ENV -- AWS staging
 * (vitana-gateway) and AWS prod (vitana-gateway-awsdr) share the same
 * Supabase oasis_events table, so without this a staging load test would
 * inflate production's numbers (or dilute a real production leak).
 */
export async function getLLMTelemetrySummary(hours = 24): Promise<LLMTelemetrySummaryResponse> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.error('[LLM Telemetry] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE');
    return { ok: false, summary: null, error: 'Gateway misconfigured: missing Supabase credentials' };
  }

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/llm_telemetry_summary`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({ p_hours: hours, p_env: VITANA_ENV }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[LLM Telemetry] Summary RPC failed: ${response.status} - ${errorText}`);
      return { ok: false, summary: null, error: `Summary query failed: ${response.status}` };
    }

    const summary = (await response.json()) as LLMTelemetrySummary;
    return { ok: true, summary };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[LLM Telemetry] Summary query error: ${errorMessage}`);
    return { ok: false, summary: null, error: errorMessage };
  }
}

/**
 * LLM Telemetry Event Types for exports
 */
export const LLM_CALL_EVENT_TYPES = LLM_TELEMETRY_EVENT_TYPES;

/**
 * Export all telemetry functions
 */
export default {
  startLLMCall,
  completeLLMCall,
  failLLMCall,
  withLLMTelemetry,
  queryLLMTelemetry,
  getLLMTelemetrySummary,
  hashPrompt,
  generateTraceId,
};
