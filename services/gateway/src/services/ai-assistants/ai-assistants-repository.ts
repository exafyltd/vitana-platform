/**
 * routes/ai-assistants.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase call in routes/ai-assistants.ts against its five
 * AI-assistant-owned tables (connector_registry, ai_provider_policies,
 * user_connections, ai_assistant_credentials, ai_consent_log) now goes
 * through here instead of calling `supabase.from(...)` inline. PURE MOVE,
 * not a rewrite: same queries, same columns, same `{ data, error }` shapes
 * — no behavior change today. Encryption/decryption of the API key itself
 * is untouched — this seam only moves the storage/retrieval of already
 * encrypted bytes, never plaintext key material.
 *
 * Left inline: `user_tenants` (resolveTenantId) — a shared/general
 * identity table, not owned by this domain, same as other B1 seams leave
 * `profiles`/`user_tenants` reads inline.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== connector_registry ====================

export async function fetchAiConnectorRegistry(supabase: SupabaseClient) {
  return supabase
    .from('connector_registry')
    .select('id, display_name, description, auth_type, capabilities, docs_url, enabled')
    .eq('category', 'ai_assistant')
    .eq('enabled', true)
    .order('display_name', { ascending: true });
}

// ==================== ai_provider_policies ====================

export async function fetchProviderPoliciesForTenant(supabase: SupabaseClient, tenantId: string) {
  return supabase.from('ai_provider_policies').select('provider, allowed, allowed_models, cost_cap_usd_month').eq('tenant_id', tenantId);
}

export async function fetchProviderPolicy(supabase: SupabaseClient, tenantId: string, provider: string) {
  return supabase.from('ai_provider_policies').select('allowed').eq('tenant_id', tenantId).eq('provider', provider).maybeSingle();
}

// ==================== user_connections ====================

export async function fetchAiConnectionsForProviders(supabase: SupabaseClient, userId: string) {
  return supabase
    .from('user_connections')
    .select('id, connector_id, is_active, connected_at')
    .eq('user_id', userId)
    .eq('category', 'ai_assistant');
}

export async function fetchAiConnectionsList(supabase: SupabaseClient, userId: string) {
  return supabase
    .from('user_connections')
    .select('id, connector_id, is_active, connected_at, disconnected_at, last_error')
    .eq('user_id', userId)
    .eq('category', 'ai_assistant')
    .order('connected_at', { ascending: false });
}

export async function fetchExistingApiKeyConnection(supabase: SupabaseClient, tenantId: string, userId: string, provider: string) {
  return supabase
    .from('user_connections')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('connector_id', provider)
    .eq('category', 'ai_assistant')
    .is('provider_user_id', null)
    .limit(1)
    .maybeSingle();
}

export async function fetchLatestConnectionForVerify(supabase: SupabaseClient, userId: string, provider: string) {
  return supabase
    .from('user_connections')
    .select('id, is_active')
    .eq('user_id', userId)
    .eq('connector_id', provider)
    .eq('category', 'ai_assistant')
    .order('connected_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function fetchActiveConnectionForDisconnect(supabase: SupabaseClient, userId: string, provider: string) {
  return supabase
    .from('user_connections')
    .select('id')
    .eq('user_id', userId)
    .eq('connector_id', provider)
    .eq('category', 'ai_assistant')
    .eq('is_active', true)
    .maybeSingle();
}

export async function insertAiConnection(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('user_connections').insert(row).select('id').single();
}

export async function updateAiConnection(supabase: SupabaseClient, connectionId: string, fields: Record<string, unknown>) {
  return supabase.from('user_connections').update(fields).eq('id', connectionId);
}

// ==================== ai_assistant_credentials ====================

export async function fetchCredentialsMetaForConnections(supabase: SupabaseClient, connectionIds: string[]) {
  return supabase.from('ai_assistant_credentials').select('connection_id, last_verified_at, last_verify_status').in('connection_id', connectionIds);
}

export async function fetchCredentialsMetaList(supabase: SupabaseClient, connectionIds: string[]) {
  return supabase
    .from('ai_assistant_credentials')
    .select('connection_id, key_prefix, key_last4, last_verified_at, last_verify_status')
    .in('connection_id', connectionIds);
}

export async function fetchCredentialForVerify(supabase: SupabaseClient, connectionId: string) {
  return supabase
    .from('ai_assistant_credentials')
    .select('encrypted_key, encryption_iv, encryption_tag, verify_failure_count')
    .eq('connection_id', connectionId)
    .maybeSingle();
}

export async function upsertAiCredentials(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('ai_assistant_credentials').upsert(row, { onConflict: 'connection_id' });
}

export async function updateAiCredentials(supabase: SupabaseClient, connectionId: string, fields: Record<string, unknown>) {
  return supabase.from('ai_assistant_credentials').update(fields).eq('connection_id', connectionId);
}

// ==================== ai_consent_log ====================

export async function insertConsentLog(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('ai_consent_log').insert(row);
}
