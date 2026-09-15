// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references admin-scanners/content-moderation.ts — zero
// coverage today.
/**
 * services/admin-scanners/content-moderation.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in content-moderation.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function countPendingMediaUploads(sb: SupabaseClient, tenantId: string) {
  return sb
    .from('media_uploads')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'pending');
}

export async function fetchOldestPendingMediaUploads(sb: SupabaseClient, tenantId: string, olderThanIso: string) {
  return sb
    .from('media_uploads')
    .select('id, created_at, media_type')
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')
    .lt('created_at', olderThanIso)
    .order('created_at', { ascending: true })
    .limit(5);
}

export async function countRecentlyFlaggedMediaUploads(sb: SupabaseClient, tenantId: string, sinceIso: string) {
  return sb
    .from('media_uploads')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'flagged')
    .gte('updated_at', sinceIso);
}
