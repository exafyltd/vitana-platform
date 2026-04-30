/**
 * VTID-DANCE-D12: Gemini call telemetry helper.
 *
 * Records every Gemini invocation to public.gemini_call_log so we have
 * cost-per-feature + outcome attribution data during the credit window
 * (May–June 2026). Drop-in helper for any service that calls Gemini.
 *
 * Best-effort: never throws. If the DB is down, the log silently drops.
 */

import { getSupabase } from '../lib/supabase';

export interface GeminiCallLogInput {
  feature:
    | 'classifier'
    | 'extractor'
    | 'matchmaker'
    | 'voice'
    | 'embedding'
    | 'pre_compute'
    | 'counter_questions'
    | 'other';
  model: string;
  status: 'success' | 'error' | 'fallback' | 'cached';
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  latency_ms?: number;
  error?: string;
  user_id?: string | null;
  vitana_id?: string | null;
  intent_id?: string | null;
  match_id?: string | null;
  metadata?: Record<string, unknown>;
}

export async function logGeminiCall(input: GeminiCallLogInput): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;

  try {
    await supabase.from('gemini_call_log').insert({
      feature: input.feature,
      model: input.model,
      status: input.status,
      prompt_tokens: input.prompt_tokens ?? null,
      completion_tokens: input.completion_tokens ?? null,
      total_tokens:
        input.total_tokens
        ?? ((input.prompt_tokens ?? 0) + (input.completion_tokens ?? 0)),
      latency_ms: input.latency_ms ?? null,
      error: input.error?.slice(0, 500) ?? null,
      user_id: input.user_id ?? null,
      vitana_id: input.vitana_id ?? null,
      intent_id: input.intent_id ?? null,
      match_id: input.match_id ?? null,
      metadata: input.metadata ?? {},
    } as any);
  } catch {
    // Silent — telemetry must never block the user-facing call.
  }
}

/** Helper that wraps an async Gemini call, captures latency + outcome. */
export async function withGeminiLog<T>(
  meta: Omit<GeminiCallLogInput, 'status' | 'latency_ms'>,
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    void logGeminiCall({
      ...meta,
      status: 'success',
      latency_ms: Date.now() - start,
    });
    return result;
  } catch (err: any) {
    void logGeminiCall({
      ...meta,
      status: 'error',
      latency_ms: Date.now() - start,
      error: err?.message ?? String(err),
    });
    throw err;
  }
}
