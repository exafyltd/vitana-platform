// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// test/data-export-consent.test.ts always injects a mock ConsentResolver
// and never exercises the default DB-backed resolver that owns these
// call sites — zero genuine coverage today.
/**
 * services/data-export-consent.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in data-export-consent.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchTenantIdForUser(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).limit(1).maybeSingle();
}

export async function fetchTenantSettingsFeatureFlags(sb: SupabaseClient, tenantId: string) {
  return sb.from('tenant_settings').select('feature_flags').eq('tenant_id', tenantId).maybeSingle();
}
