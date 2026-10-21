// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior); exercised indirectly
// by d49-risk-mitigation-engine.ts's existing test suite
// (test/services/d49-risk-mitigation-engine.test.ts), which covers every
// call site here.
/**
 * services/d49-risk-mitigation-engine.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in
 * d49-risk-mitigation-engine.ts now goes through here instead of being
 * written inline. PURE MOVE, not a rewrite: same queries, same columns,
 * same conditional-filter logic, same return shapes — no behavior change
 * today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function bootstrapDevRequestContext(sb: SupabaseClient, tenantId: string, activeRole: string) {
  return sb.rpc('dev_bootstrap_request_context', { p_tenant_id: tenantId, p_active_role: activeRole });
}

export async function fetchRecentMitigation(sb: SupabaseClient, userId: string, domain: string, suggestionHash: string, sinceIso: string) {
  return sb
    .from('risk_mitigations')
    .select('id, created_at')
    .eq('user_id', userId)
    .eq('domain', domain)
    .eq('suggestion_hash', suggestionHash)
    .gte('created_at', sinceIso)
    .limit(1);
}

export async function insertRiskMitigation(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('risk_mitigations').insert(row);
}

export async function dismissMitigationRow(sb: SupabaseClient, mitigationId: string, patch: Record<string, unknown>) {
  return sb.from('risk_mitigations').update(patch).eq('id', mitigationId).select('id, domain').single();
}

export async function fetchActiveMitigations(sb: SupabaseClient, params: { nowIso: string; limit: number; domains?: string[] }) {
  let q = sb.from('risk_mitigations').select('*').eq('status', 'active').gte('expires_at', params.nowIso).order('created_at', { ascending: false }).limit(params.limit);
  if (params.domains && params.domains.length > 0) q = q.in('domain', params.domains);
  return q;
}

export async function fetchMitigationHistory(sb: SupabaseClient, params: { limit: number; domains?: string[]; statuses?: string[]; since?: string }) {
  let q = sb.from('risk_mitigations').select('*').order('created_at', { ascending: false }).limit(params.limit);
  if (params.domains && params.domains.length > 0) q = q.in('domain', params.domains);
  if (params.statuses && params.statuses.length > 0) q = q.in('status', params.statuses);
  if (params.since) q = q.gte('created_at', params.since);
  return q;
}

export async function acknowledgeMitigationRow(sb: SupabaseClient, mitigationId: string, patch: Record<string, unknown>) {
  return sb.from('risk_mitigations').update(patch).eq('id', mitigationId).eq('status', 'active');
}

export async function expireOldMitigationsRows(sb: SupabaseClient, nowIso: string, patch: Record<string, unknown>) {
  return sb.from('risk_mitigations').update(patch).eq('status', 'active').lt('expires_at', nowIso).select('id');
}
