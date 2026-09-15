// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note: no
// test file references controllers/governance-controller.ts — zero
// coverage today.
/**
 * controllers/governance-controller.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in governance-controller.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter/order/join logic,
 * same `{ data, error }` shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 *
 * Three functions (`buildRulesQuery`, `buildProposalsQuery`,
 * `buildEvaluationsQuery`) return only the query-initiating builder,
 * `: any` typed, so the caller's conditional filters keep mutating it
 * in place exactly as before — the same query-initiation-only pattern
 * already applied elsewhere in this sweep (e.g.
 * discover-search-repository.ts's buildProductSearchQuery).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== governance_rules ====================

export async function fetchActiveGovernanceRules(sb: SupabaseClient, tenantId: string) {
  return sb
    .from('governance_rules')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_active', true);
}

export async function fetchGovernanceRulesWithCategories(sb: SupabaseClient, tenantId: string) {
  return sb
    .from('governance_rules')
    .select(`
        *,
        governance_categories (
            name,
            code,
            description
        )
    `)
    .eq('tenant_id', tenantId)
    .order('rule_id', { ascending: true });
}

export function buildRulesQuery(sb: SupabaseClient, tenantId: string): any {
  return sb
    .from('governance_rules')
    .select(`
        *,
        governance_categories (
            name,
            code
        )
    `)
    .eq('tenant_id', tenantId)
    .order('rule_id', { ascending: true });
}

export async function fetchGovernanceRuleByCode(sb: SupabaseClient, tenantId: string, ruleCode: string) {
  return sb
    .from('governance_rules')
    .select(`
        *,
        governance_categories (
            name
        )
    `)
    .eq('tenant_id', tenantId)
    .eq('logic->>rule_code', ruleCode)
    .limit(1);
}

export async function fetchGovernanceRuleByCodeRaw(sb: SupabaseClient, tenantId: string, ruleCode: string) {
  return sb
    .from('governance_rules')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('logic->>rule_code', ruleCode)
    .limit(1);
}

// ==================== governance_evaluations ====================

export async function fetchRecentGovernanceEvaluations(sb: SupabaseClient, ruleId: string, limit: number) {
  return sb
    .from('governance_evaluations')
    .select('*')
    .eq('rule_id', ruleId)
    .order('evaluated_at', { ascending: false })
    .limit(limit);
}

// ==================== governance_proposals ====================

export function buildProposalsQuery(sb: SupabaseClient, tenantId: string): any {
  return sb
    .from('governance_proposals')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
}

export async function insertGovernanceProposal(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb
    .from('governance_proposals')
    .insert(row)
    .select()
    .single();
}

export async function fetchGovernanceProposalById(sb: SupabaseClient, tenantId: string, proposalId: string) {
  return sb
    .from('governance_proposals')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('proposal_id', proposalId)
    .single();
}

export async function updateGovernanceProposal(sb: SupabaseClient, proposalId: string, fields: Record<string, unknown>) {
  return sb
    .from('governance_proposals')
    .update(fields)
    .eq('proposal_id', proposalId)
    .select()
    .single();
}

// ==================== oasis_events (governance-scoped reads) ====================

export function buildEvaluationsQuery(sb: SupabaseClient): any {
  return sb
    .from('oasis_events')
    .select('*')
    .eq('topic', 'governance.evaluate')
    .order('created_at', { ascending: false });
}

export async function fetchGovernanceLogs(sb: SupabaseClient, limit: number) {
  return sb
    .from('oasis_events')
    .select('*')
    .eq('service', 'governance') // Filter by service
    .order('created_at', { ascending: false })
    .limit(limit);
}

// ==================== governance_violations ====================

export async function fetchGovernanceViolations(sb: SupabaseClient, tenantId: string) {
  return sb
    .from('governance_violations')
    .select(`
        *,
        governance_rules (
            logic
        )
    `)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
}

// ==================== oasis_events_v1 (feed) ====================

export async function fetchGovernanceFeedEvents(sb: SupabaseClient, limit: number) {
  return sb
    .from('oasis_events_v1')
    .select('*')
    .eq('tenant', 'SYSTEM')
    .or('task_type.like.%governance%,notes.like.%governance%')
    .order('created_at', { ascending: false })
    .limit(limit);
}

// ==================== governance_enforcements ====================

export async function fetchGovernanceEnforcements(sb: SupabaseClient, tenantId: string, limit: number) {
  return sb
    .from('governance_enforcements')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('executed_at', { ascending: false })
    .limit(limit);
}
