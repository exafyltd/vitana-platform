// impact-allow-no-test: pure data-access seam (thin Supabase RPC
// wrappers, no independent request-handling behavior). Coverage note:
// no test file references routes/locations.ts genuinely — the two
// references in test/memory.test.ts and test/memory-confidence.test.ts
// are jest.mock('../src/routes/locations', ...) wholesale mocks of the
// module (memory.ts imports processLocationMentionsFromDiary from it),
// not exercises of this module's own call sites. Zero coverage today.
/**
 * routes/locations.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.rpc(...)` call in this file now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same RPC
 * names, same params, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Reused by the diary-mention auto-create flow and the direct POST /add route. */
export async function locationAddRpc(sb: SupabaseClient, payload: unknown) {
  return sb.rpc('location_add', { p_payload: payload });
}

/** Reused by the diary-mention auto-checkin flow and the direct POST /checkin route. */
export async function locationCheckinRpc(sb: SupabaseClient, payload: unknown) {
  return sb.rpc('location_checkin', { p_payload: payload });
}

export async function getLocationVisitsRpc(sb: SupabaseClient, params: { p_from: unknown; p_to: unknown; p_limit: unknown }) {
  return sb.rpc('location_get_visits', params);
}

export async function nearbyLocationDiscoveryRpc(sb: SupabaseClient, params: { p_lat: unknown; p_lng: unknown; p_radius_km: unknown; p_topic_keys: unknown }) {
  return sb.rpc('location_nearby_discovery', params);
}

export async function getLocationPreferencesRpc(sb: SupabaseClient) {
  return sb.rpc('location_preferences_get');
}

export async function setLocationPreferencesRpc(sb: SupabaseClient, payload: unknown) {
  return sb.rpc('location_preferences_set', { p_payload: payload });
}
