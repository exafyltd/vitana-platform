// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// test/llm-provider-verify.test.ts only imports the zod schema exports
// from routes/llm.ts (ProviderEnum, StageConfigSchema, PolicySchema),
// not the route handler that owns these two call sites — zero genuine
// coverage today.
/**
 * routes/llm.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in llm.ts now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchActiveTenantIdForUser(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).eq('is_active', true).limit(1).maybeSingle();
}

export async function countActiveTenantConnectorConnections(sb: SupabaseClient, tenantId: string, connectorId: string) {
  return sb
    .from('user_connections')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('connector_id', connectorId)
    .eq('category', 'ai_assistant')
    .eq('is_active', true);
}
