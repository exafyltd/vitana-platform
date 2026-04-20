/**
 * BOOTSTRAP-ORB-DELEGATION-SCAFFOLD: Token + cost tracking for delegated AI calls.
 *
 * Every delegation call — success OR failure — writes one row to the
 * `ai_usage_log` table. The table is aggregated by a materialized view
 * (`ai_usage_month_by_user_provider`) that the budget checker reads without
 * having to scan the full log.
 *
 * Fire-and-forget: logUsage never throws. A failed insert degrades to a
 * console warning — we never block the orb session on telemetry.
 */
import { getSupabase } from '../../lib/supabase';
import type {
  DelegationProviderId,
  DelegationStrength,
  DelegationUsage,
} from './types';

const LOG_PREFIX = '[orb/delegation/usage]';

export type UsageStatus = 'ok' | 'timeout' | 'error' | 'cap_exceeded' | 'unauthorized';

export interface LogUsageInput {
  readonly userId: string;
  readonly tenantId: string | null;
  readonly connectionId: string | null;
  readonly providerId: DelegationProviderId;
  readonly model: string;
  readonly sessionId: string;
  readonly vtid: string;
  readonly latencyMs: number;
  readonly status: UsageStatus;
  readonly usage?: DelegationUsage;
  readonly taskClass?: DelegationStrength;
  readonly errorMessage?: string;
  readonly metadata?: Record<string, unknown>;
}

export function logUsage(input: LogUsageInput): void {
  const supabase = getSupabase();
  if (!supabase) return;

  const row = {
    user_id: input.userId,
    tenant_id: input.tenantId,
    connection_id: input.connectionId,
    provider: input.providerId,
    model: input.model,
    request_tokens: input.usage?.inputTokens ?? 0,
    response_tokens: input.usage?.outputTokens ?? 0,
    estimated_cost_usd: input.usage?.costUsd ?? 0,
    session_id: input.sessionId,
    vtid: input.vtid,
    latency_ms: input.latencyMs,
    status: input.status,
    metadata: {
      ...(input.metadata || {}),
      task_class: input.taskClass ?? null,
      error_message: input.errorMessage ?? null,
    },
  };

  supabase
    .from('ai_usage_log')
    .insert(row)
    .then(({ error }) => {
      if (error) {
        console.warn(`${LOG_PREFIX} insert failed for user=${input.userId.substring(0, 8)}... provider=${input.providerId}: ${error.message}`);
      }
    });
}

/**
 * Compute cost in USD from token counts using the provider's rate card.
 * Separated from the adapter so budget estimation can reuse the same math
 * for pre-flight cap checks.
 */
export function computeCostUsd(
  inputTokens: number,
  outputTokens: number,
  rates: { input: number; output: number },
): number {
  // rates are USD per 1M tokens
  return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}
