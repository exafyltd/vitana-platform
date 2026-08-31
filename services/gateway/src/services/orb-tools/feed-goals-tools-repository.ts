// Genuinely tested via test/orb-tools/feed-goals-tools.test.ts, which
// drives a real functional fake SupabaseClient (query-chain builder), not
// a wholesale module mock.
/**
 * orb-tools/feed-goals-tools.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in orb-tools/feed-goals-tools.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param) — tools receive their client per-call, not a module-level
 * singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function updateOwnPostContent(sb: SupabaseClient, postId: string, userId: string, content: string) {
  return sb.from('profile_posts').update({ content }).eq('id', postId).eq('user_id', userId).select('id').maybeSingle();
}

export async function deleteOwnPost(sb: SupabaseClient, postId: string, userId: string) {
  return sb.from('profile_posts').delete().eq('id', postId).eq('user_id', userId).select('id').maybeSingle();
}
