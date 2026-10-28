// Genuine coverage: test/routes/tenant-admin/assistant-config.test.ts
// mocks getSupabase() and createClient() at the module boundary (not
// this module), plus mocks the unrelated ai-personality-service — a
// real functional fake client, not a wholesale mock of the code under
// test.
/**
 * routes/tenant-admin/assistant-config.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in assistant-config.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same delete, same filters, same return shape — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function deleteTenantAssistantConfig(sb: SupabaseClient, tenantId: string, surfaceKey: string) {
  return sb
    .from('tenant_assistant_config')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('surface_key', surfaceKey);
}
