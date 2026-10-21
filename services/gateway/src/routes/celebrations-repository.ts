// Coverage note: test/celebrations.test.ts exercises this route
// against a mocked '@supabase/supabase-js' createClient (a functional
// fake, not a wholesale mock of this repository module), so these
// wrappers get genuine coverage, not a documented zero.
/**
 * routes/celebrations.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in celebrations.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same insert payload, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchPriorCelebrationNotification(
  sb: SupabaseClient,
  args: { userId: string; tenantId: string; type: string; sinceIso: string; dedupeKey: string },
) {
  return sb
    .from('user_notifications')
    .select('id')
    .eq('user_id', args.userId)
    .eq('tenant_id', args.tenantId)
    .eq('type', args.type)
    .gte('created_at', args.sinceIso)
    .filter('data->>dedupe_key', 'eq', args.dedupeKey)
    .limit(1)
    .maybeSingle();
}

export async function insertCelebrationNotification(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('user_notifications').insert(row);
}
