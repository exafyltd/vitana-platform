/**
 * orb-tools/developer-tools.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in orb-tools/developer-tools.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param) — tools receive their client per-call, not a module-level
 * singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== vtid_ledger ====================

export async function fetchRecentVtids(sb: SupabaseClient, status: string, limit: number) {
  let q = sb
    .from('vtid_ledger')
    .select('vtid, title, description, status, spec_status, is_terminal, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (status) q = q.eq('status', status);
  return q;
}

export async function fetchVtidByCandidates(sb: SupabaseClient, candidates: string[]) {
  return sb
    .from('vtid_ledger')
    .select('vtid, title, description, status, spec_status, is_terminal, terminal_outcome, claimed_by, created_at, updated_at')
    .in('vtid', candidates)
    .limit(1);
}

export async function fetchVtidKeyByCandidates(sb: SupabaseClient, candidates: string[]) {
  return sb.from('vtid_ledger').select('vtid').in('vtid', candidates).limit(1);
}

export async function fetchActiveHealingTasks(sb: SupabaseClient, activeStatuses: string[]) {
  return sb
    .from('vtid_ledger')
    .select('vtid, title, status, spec_status, created_at')
    .filter('metadata->>source', 'eq', 'self-healing')
    .in('status', activeStatuses)
    .order('created_at', { ascending: false })
    .limit(20);
}

export async function fetchRecentlyTerminalizedVtids(sb: SupabaseClient, sinceIso: string) {
  return sb
    .from('vtid_ledger')
    .select('vtid, title, terminal_outcome, updated_at')
    .eq('is_terminal', true)
    .gte('updated_at', sinceIso)
    .order('updated_at', { ascending: false })
    .limit(20);
}

// ==================== oasis_events ====================

export async function fetchVoiceSessionStartEvents(sb: SupabaseClient, topics: string[], vtids: string[]) {
  return sb
    .from('oasis_events')
    .select('created_at, vitana_id, metadata')
    .in('topic', topics)
    .in('vtid', vtids)
    .order('created_at', { ascending: false })
    .limit(40);
}

export async function fetchVoiceSessionEndEvents(sb: SupabaseClient, topics: string[], vtids: string[]) {
  return sb
    .from('oasis_events')
    .select('created_at, vitana_id, metadata')
    .in('topic', topics)
    .in('vtid', vtids)
    .order('created_at', { ascending: false })
    .limit(100);
}

// ==================== routines / routine_runs ====================

export async function fetchAllRoutines(sb: SupabaseClient) {
  return sb
    .from('routines')
    .select('name, display_name, cron_schedule, enabled, last_run_at, last_run_status, last_run_summary, consecutive_failures')
    .order('name', { ascending: true });
}

export async function fetchRoutineByExactName(sb: SupabaseClient, name: string) {
  return sb.from('routines').select('*').eq('name', name).limit(1);
}

export async function fetchRoutineByFuzzyName(sb: SupabaseClient, needle: string) {
  return sb
    .from('routines')
    .select('*')
    .or(`name.ilike.%${needle}%,display_name.ilike.%${needle}%`)
    .limit(1);
}

export async function fetchRoutineRuns(sb: SupabaseClient, routineName: string, limit: number) {
  return sb
    .from('routine_runs')
    .select('id, started_at, finished_at, status, trigger, summary, error, duration_ms')
    .eq('routine_name', routineName)
    .order('started_at', { ascending: false })
    .limit(limit);
}

// ==================== self_healing_log ====================

export async function fetchPendingHealingDiagnoses(sb: SupabaseClient) {
  return sb
    .from('self_healing_log')
    .select('id, vtid, endpoint, failure_class, created_at')
    .eq('outcome', 'pending')
    .order('created_at', { ascending: false })
    .limit(20);
}

export async function fetchPendingHealingDiagnosesDetailed(sb: SupabaseClient) {
  return sb
    .from('self_healing_log')
    .select('id, vtid, endpoint, failure_class, created_at, diagnosis, attempt_number')
    .eq('outcome', 'pending')
    .order('created_at', { ascending: false })
    .limit(50);
}

// ==================== autopilot_recommendations ====================

export async function fetchNewDevAutopilotFindings(sb: SupabaseClient) {
  return sb
    .from('autopilot_recommendations')
    .select('id, title, summary, risk_class, impact_score, effort_score, auto_exec_eligible, domain, first_seen_at, seen_count, spec_snapshot')
    .eq('source_type', 'dev_autopilot')
    .eq('status', 'new')
    .order('impact_score', { ascending: false, nullsFirst: false })
    .limit(50);
}

// ==================== dev_autopilot_executions ====================

export async function fetchInflightAutopilotExecutions(sb: SupabaseClient, inflightStatuses: string[]) {
  return sb
    .from('dev_autopilot_executions')
    .select('id, finding_id, status, pr_url, pr_number, branch, execute_after, auto_fix_depth, self_healing_vtid, created_at, updated_at')
    .in('status', inflightStatuses)
    .order('created_at', { ascending: false })
    .limit(50);
}

// ==================== test_contracts ====================

export async function fetchFailingTestContracts(sb: SupabaseClient) {
  return sb
    .from('test_contracts')
    .select('id, capability, service, environment, target_endpoint, target_file, owner, status, last_status, last_run_at, last_failure_signature')
    .in('status', ['fail', 'quarantined'])
    .order('last_run_at', { ascending: false, nullsFirst: false })
    .limit(50);
}

// ==================== agents_registry ====================

export async function fetchAgentsRegistry(sb: SupabaseClient, tier: string) {
  let q = sb
    .from('agents_registry')
    .select('agent_id, display_name, tier, status, last_heartbeat_at, llm_provider')
    .order('tier', { ascending: true })
    .order('agent_id', { ascending: true });
  if (tier) q = q.eq('tier', tier);
  return q;
}
