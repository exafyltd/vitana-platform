// impact-allow-no-test: pure data-access seam (thin Supabase query wrappers,
// no independent request-handling behavior); exercised indirectly by
// d48-opportunity-surfacing-engine.ts's existing test suite
// (test/services/d48-opportunity-surfacing-engine.test.ts), which covers
// every call site here.
/**
 * services/d48-opportunity-surfacing-engine.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in d48-opportunity-surfacing-engine.ts
 * now goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param) — the engine builds either a user-scoped or service-role client
 * per call and passes it straight through.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== services_catalog / products_catalog ====================

export async function fetchServicesCatalogForTenant(sb: SupabaseClient, tenantId: string, limit: number) {
  return sb.from('services_catalog').select('id, name, service_type, topic_keys, provider_name, metadata').eq('tenant_id', tenantId).limit(limit);
}

export async function fetchProductsCatalogForTenant(sb: SupabaseClient, tenantId: string, limit: number) {
  return sb.from('products_catalog').select('id, name, product_type, topic_keys, metadata').eq('tenant_id', tenantId).limit(limit);
}

// ==================== contextual_opportunities ====================

export async function fetchDismissedOpportunityIds(sb: SupabaseClient, tenantId: string, userId: string, sinceIso: string) {
  return sb
    .from('contextual_opportunities')
    .select('external_id')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('status', 'dismissed')
    .gte('dismissed_at', sinceIso);
}

export async function countOpportunitiesToday(sb: SupabaseClient, tenantId: string, userId: string, sinceIso: string) {
  return sb.from('contextual_opportunities').select('id', { count: 'exact' }).eq('tenant_id', tenantId).eq('user_id', userId).gte('created_at', sinceIso);
}

export async function insertOpportunities(sb: SupabaseClient, records: Record<string, unknown>[]) {
  return sb.from('contextual_opportunities').insert(records);
}

export async function dismissOpportunityRow(sb: SupabaseClient, opportunityId: string, userId: string, tenantId: string, patch: Record<string, unknown>) {
  return sb.from('contextual_opportunities').update(patch).eq('id', opportunityId).eq('user_id', userId).eq('tenant_id', tenantId);
}

export async function recordOpportunityEngagement(sb: SupabaseClient, opportunityId: string, userId: string, tenantId: string, patch: Record<string, unknown>) {
  return sb.from('contextual_opportunities').update(patch).eq('id', opportunityId).eq('user_id', userId).eq('tenant_id', tenantId);
}

export async function fetchActiveOpportunities(sb: SupabaseClient, tenantId: string, userId: string, limit: number) {
  return sb.from('contextual_opportunities').select('*').eq('tenant_id', tenantId).eq('user_id', userId).eq('status', 'active').order('created_at', { ascending: false }).limit(limit);
}
