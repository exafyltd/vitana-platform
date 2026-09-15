// Genuinely tested via test/orb-tools/live-rooms-tools.test.ts, which
// drives a real functional fake SupabaseClient (query-chain builder), not
// a wholesale module mock.
/**
 * orb-tools/live-rooms-tools.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in orb-tools/live-rooms-tools.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param) — tools receive their client per-call, not a module-level
 * singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchLiveRoomsNow(sb: SupabaseClient, tenantId: string) {
  return sb
    .from('live_rooms')
    .select('id, title, starts_at, status')
    .eq('tenant_id', tenantId)
    .in('status', ['scheduled', 'live'])
    .order('starts_at', { ascending: true })
    .limit(20);
}
