// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// referencing test files only import registerHandler/getHandler (a pure
// in-memory registry, no DB access); the 3 files that jest.mock
// automation-executor.ts do so wholesale. Zero genuine coverage of these
// queries today.
/**
 * services/automation-executor.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in automation-executor.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { RoleTarget, RunStatus } from '../types/automations';

export async function fetchAutopilotPromptMaxPerDay(sb: SupabaseClient, userId: string) {
  return sb.from('autopilot_prompt_prefs').select('max_prompts_per_day').eq('user_id', userId).maybeSingle();
}

export function insertAutomationRun(
  sb: SupabaseClient,
  row: {
    id: string;
    tenant_id: string;
    automation_id: string;
    trigger_type: string;
    trigger_source: string | undefined;
    status: string;
    started_at: string;
  },
): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('automation_runs').insert(row);
}

export function updateAutomationRun(
  sb: SupabaseClient,
  runId: string,
  patch: {
    status: RunStatus;
    users_affected: number;
    actions_taken: number;
    error_message: string | undefined;
    metadata: Record<string, unknown>;
    completed_at: string;
  },
): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('automation_runs').update(patch).eq('id', runId);
}

export async function fetchUsersByRole(
  sb: SupabaseClient,
  tenantId: string,
  selectColumns: string,
  targetRoles: RoleTarget,
): Promise<{ data: any; error: any }> {
  let query = sb.from('user_tenants').select(selectColumns).eq('tenant_id', tenantId);
  if (targetRoles !== 'all') {
    query = query.in('active_role', targetRoles);
  }
  return query;
}

export async function fetchAutomationRunHistory(sb: SupabaseClient, tenantId: string, automationId: string | undefined, limit: number) {
  let query = sb
    .from('automation_runs')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (automationId) {
    query = query.eq('automation_id', automationId);
  }
  return query;
}

export async function fetchActiveAutomationRuns(sb: SupabaseClient, tenantId: string) {
  return sb
    .from('automation_runs')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'running')
    .order('started_at', { ascending: false });
}
