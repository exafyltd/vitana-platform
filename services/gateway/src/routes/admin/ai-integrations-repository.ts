// impact-allow-no-test: pure data-access seam (thin Supabase query/upsert
// wrappers, no independent request-handling behavior). Coverage note: NO
// call site in routes/admin/ai-integrations.ts has any test coverage
// today — no test file in this repo references this route.
/**
 * routes/admin/ai-integrations.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/admin/ai-integrations.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchAiAssistantConnectorCatalog(sb: SupabaseClient) {
  return sb.from('connector_registry').select('*').eq('category', 'ai_assistant').order('display_name', { ascending: true });
}

export async function updateConnectorRegistryEntry(sb: SupabaseClient, provider: string, updates: Record<string, unknown>) {
  return sb.from('connector_registry').update(updates).eq('id', provider).eq('category', 'ai_assistant').select('*').maybeSingle();
}

/** Reused across every route that accepts a tenant param that may be a slug instead of a UUID. */
export async function resolveTenantIdBySlug(sb: SupabaseClient, slug: string) {
  return sb.from('tenants').select('tenant_id').eq('slug', slug).maybeSingle();
}

export async function fetchAiProviderPolicies(sb: SupabaseClient, tenantId: string) {
  return sb.from('ai_provider_policies').select('*').eq('tenant_id', tenantId);
}

export async function fetchAiProviderPolicyForTenantAndProvider(sb: SupabaseClient, tenantId: string, provider: string) {
  return sb.from('ai_provider_policies').select('*').eq('tenant_id', tenantId).eq('provider', provider).maybeSingle();
}

export async function upsertAiProviderPolicy(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('ai_provider_policies').upsert(row, { onConflict: 'tenant_id,provider' }).select('*').single();
}

export async function insertAiConsentLogEntry(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('ai_consent_log').insert(row);
}

export async function fetchAiAssistantConnections(
  sb: SupabaseClient,
  filters: { tenantId: string | null; provider: string | null; status: 'active' | 'inactive' | null },
) {
  let query = sb
    .from('user_connections')
    .select('id, tenant_id, user_id, connector_id, is_active, connected_at, disconnected_at, last_error')
    .eq('category', 'ai_assistant')
    .order('connected_at', { ascending: false })
    .limit(200);
  if (filters.tenantId) query = query.eq('tenant_id', filters.tenantId);
  if (filters.provider) query = query.eq('connector_id', filters.provider);
  if (filters.status === 'active') query = query.eq('is_active', true);
  if (filters.status === 'inactive') query = query.eq('is_active', false);
  return query;
}

export async function fetchAiAssistantCredentialsByConnectionIds(sb: SupabaseClient, connectionIds: string[]) {
  return sb
    .from('ai_assistant_credentials')
    .select('connection_id, key_prefix, key_last4, last_verified_at, last_verify_status')
    .in('connection_id', connectionIds);
}

export async function fetchAiConsentLog(
  sb: SupabaseClient,
  filters: { tenantId: string | null; userId: string | null; provider: string | null; limit: number },
) {
  let query = sb.from('ai_consent_log').select('*').order('ts', { ascending: false }).limit(filters.limit);
  if (filters.tenantId) query = query.eq('tenant_id', filters.tenantId);
  if (filters.userId) query = query.eq('user_id', filters.userId);
  if (filters.provider) query = query.eq('provider', filters.provider);
  return query;
}
