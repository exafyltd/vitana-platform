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
import { fetchTenantMembersWithEffectiveRole } from './orchestrator/active-role';
import { fetchExcludedTestServiceAccountIds } from '../lib/excluded-test-service-accounts';

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

/**
 * VTID-04318: targets on the EFFECTIVE role (role_preferences first, then
 * user_tenants.active_role — the rule the ORB uses, see
 * orchestrator/active-role.ts) instead of user_tenants.active_role alone,
 * and never returns a test/service/automation account (CLAUDE.md rules
 * 43-45; fetchExcludedTestServiceAccountIds fails open to "no exclusions").
 * The role filter moved from SQL into memory because the effective role
 * spans two tables; `active_role` on each returned row IS the effective role.
 */
export async function fetchUsersByRole(
  sb: SupabaseClient,
  tenantId: string,
  selectColumns: string,
  targetRoles: RoleTarget,
): Promise<{ data: any; error: any }> {
  const [members, excluded] = await Promise.all([
    fetchTenantMembersWithEffectiveRole(sb, tenantId, selectColumns),
    fetchExcludedTestServiceAccountIds(sb),
  ]);
  if (members.error) return { data: null, error: members.error };
  const wanted = targetRoles === 'all' ? null : new Set<string>(targetRoles as string[]);
  const data = (members.data || []).filter(
    (m) => !excluded.has(m.user_id) && (wanted === null || (m.active_role !== null && wanted.has(m.active_role))),
  );
  return { data, error: null };
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
