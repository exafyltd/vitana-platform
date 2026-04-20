/**
 * BOOTSTRAP-ORB-DELEGATION-SCAFFOLD: Enforce the existing per-tenant,
 * per-provider monthly cap (`ai_provider_policies.cost_cap_usd_month`)
 * against cumulative spend in `ai_usage_log`.
 *
 * Strategy:
 *   - Read `cost_cap_usd_month` from ai_provider_policies (created in
 *     VTID-02403 Phase 1).
 *   - Read current-month spend from ai_usage_month_by_user_provider
 *     materialized view (created in this phase's migration).
 *   - Deny if projected cost for the pending call would exceed cap.
 *
 * Graceful: if either lookup fails, the request is ALLOWED and a warning is
 * logged. The orb voice session must not be blocked by a telemetry DB hiccup.
 */
import { getSupabase } from '../../lib/supabase';
import type { DelegationProviderId } from './types';

const LOG_PREFIX = '[orb/delegation/budget]';

export interface BudgetCheckResult {
  readonly allowed: boolean;
  readonly capUsd: number | null;
  readonly spentUsd: number;
  readonly remainingUsd: number | null;
  readonly reason?: 'cap_exceeded' | 'no_cap_configured' | 'lookup_failed';
}

export interface BudgetCheckInput {
  readonly tenantId: string | null;
  readonly userId: string;
  readonly providerId: DelegationProviderId;
  /** Upper-bound estimate of the pending call cost. Usually small (<0.01). */
  readonly estimatedCostUsd: number;
}

export async function checkBudget(input: BudgetCheckInput): Promise<BudgetCheckResult> {
  const supabase = getSupabase();
  if (!supabase) {
    return { allowed: true, capUsd: null, spentUsd: 0, remainingUsd: null, reason: 'lookup_failed' };
  }

  // Pull the cap (tenant-scoped policy)
  let capUsd: number | null = null;
  if (input.tenantId) {
    const { data: policy, error: policyErr } = await supabase
      .from('ai_provider_policies')
      .select('cost_cap_usd_month')
      .eq('tenant_id', input.tenantId)
      .eq('provider', input.providerId)
      .maybeSingle();
    if (policyErr) {
      console.warn(`${LOG_PREFIX} policy lookup failed: ${policyErr.message}`);
    } else if (policy?.cost_cap_usd_month != null) {
      capUsd = Number(policy.cost_cap_usd_month);
    }
  }

  // No cap configured → allow (tenant hasn't opted into budget control)
  if (capUsd == null || capUsd <= 0) {
    return {
      allowed: true,
      capUsd,
      spentUsd: 0,
      remainingUsd: null,
      reason: capUsd == null ? 'no_cap_configured' : undefined,
    };
  }

  // Pull current-month spend for (user, provider) from the materialized view.
  const { data: monthly, error: spentErr } = await supabase
    .from('ai_usage_month_by_user_provider')
    .select('total_cost_usd')
    .eq('user_id', input.userId)
    .eq('provider', input.providerId)
    .maybeSingle();

  if (spentErr) {
    console.warn(`${LOG_PREFIX} monthly-spend lookup failed: ${spentErr.message}`);
    return { allowed: true, capUsd, spentUsd: 0, remainingUsd: capUsd, reason: 'lookup_failed' };
  }

  const spentUsd = Number(monthly?.total_cost_usd ?? 0);
  const projected = spentUsd + Math.max(0, input.estimatedCostUsd);
  const remaining = capUsd - spentUsd;

  if (projected > capUsd) {
    return {
      allowed: false,
      capUsd,
      spentUsd,
      remainingUsd: remaining,
      reason: 'cap_exceeded',
    };
  }

  return { allowed: true, capUsd, spentUsd, remainingUsd: remaining };
}
