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
import { estimateCost } from '../constants/llm-defaults';
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
export async function startLLMCall(params: {
  vtid: string | null;
  threadId?: string;
  service: string;
  stage: LLMStage;
  domain?: WorkerDomain;
  provider: LLMProvider | string;
  model: string;
  prompt: string;
  agentConfigVersion?: string;
}): Promise<LLMCallContext> {
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
  };

  await emitOasisEvent({
    vtid: params.vtid || 'VTID-01208',
    type: 'llm.call.started',
    source: params.service,
    status: 'info',
    message: `LLM call started: ${params.stage} using ${params.provider}/${params.model}`,
    payload: payload as unknown as Record<string, unknown>,
  });

  return context;
}

/**
 * Complete an LLM call - emits llm.call.completed event
 */
export async function completeLLMCall(
  context: LLMCallContext,
  result: {
    inputTokens?: number;
    outputTokens?: number;
    requestId?: string;
    fallbackUsed?: boolean;
    fallbackFrom?: string;
    fallbackTo?: string;
    retryCount?: number;
  }
): Promise<void> {
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
  };

  await emitOasisEvent({
    vtid: context.vtid || 'VTID-01208',
    type: 'llm.call.completed',
    source: context.service,
    status: 'success',
    message: `LLM call completed: ${context.stage} in ${latencyMs}ms${result.fallbackUsed ? ' (fallback)' : ''}`,
    payload: payload as unknown as Record<string, unknown>,
  });
}

/**
 * Fail an LLM call - emits llm.call.failed event
 */
export async function failLLMCall(
  context: LLMCallContext,
  error: {
    code?: string;
    message: string;
    retryCount?: number;
    fallbackUsed?: boolean;
    fallbackFrom?: string;
    fallbackTo?: string;
  }
): Promise<void> {
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
  };

  await emitOasisEvent({
    vtid: context.vtid || 'VTID-01208',
    type: 'llm.call.failed',
    source: context.service,
    status: 'error',
    message: `LLM call failed: ${context.stage} - ${error.message}`,
    payload: payload as unknown as Record<string, unknown>,
  });
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
  hashPrompt,
  generateTraceId,
};
