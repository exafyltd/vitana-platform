// impact-allow-no-test: pure data-access seam (thin Supabase RPC
// wrappers, no independent request-handling behavior). Coverage note:
// test/d34-environmental-mobility-engine.test.ts exercises this module
// directly but only ever passes a `null` supabase client (or hits the
// explicit-override branch), so the RPC call sites themselves are never
// invoked; test/orb-tools/awareness-tools.test.ts wholesale
// jest.mocks the module. Zero genuine coverage of these RPC calls today.
/**
 * services/d34-environmental-mobility-engine.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.rpc(...)` call in
 * d34-environmental-mobility-engine.ts now goes through here instead of
 * being written inline. PURE MOVE, not a rewrite: same RPCs, same
 * params, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param) — mirrors the source file's
 * own existing convention of threading `supabase: SupabaseClient | null`
 * through its functions.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchLocationPreferences(sb: SupabaseClient) {
  return sb.rpc('location_preferences_get');
}

export async function fetchLocationVisits(sb: SupabaseClient, limit: number) {
  return sb.rpc('location_get_visits', { p_from: null, p_to: null, p_limit: limit });
}

export async function fetchUserPreferencesBundle(sb: SupabaseClient) {
  return sb.rpc('user_preferences_get_bundle');
}

export async function devBootstrapRequestContext(sb: SupabaseClient, tenantId: string, activeRole: string) {
  return sb.rpc('dev_bootstrap_request_context', { p_tenant_id: tenantId, p_active_role: activeRole });
}
