// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior); exercised
// indirectly by community-activity-builder.ts's existing test suite
// (test/services/social-memory/community-activity-builder.test.ts), which
// mocks only ../../lib/supabase (the client factory) and
// social-memory-repository (a sibling module), not this module itself.
/**
 * services/social-memory/community-activity-builder.ts — Aurora migration
 * B1 data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in community-activity-builder.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchPersonEventParticipations(sb: SupabaseClient, personId: string, since: string, limit: number) {
  return sb
    .from('global_event_participants')
    .select('event_id, registered_at')
    .eq('user_id', personId)
    .gte('registered_at', since)
    .order('registered_at', { ascending: false })
    .limit(limit);
}

export async function fetchPersonGroupJoins(sb: SupabaseClient, personId: string, since: string, limit: number) {
  return sb
    .from('global_community_group_members')
    .select('group_id, joined_at')
    .eq('user_id', personId)
    .gte('joined_at', since)
    .order('joined_at', { ascending: false })
    .limit(limit);
}

export async function fetchCommunityGroupNames(sb: SupabaseClient, groupIds: string[]) {
  return sb.from('global_community_groups').select('id, name').in('id', groupIds);
}

export async function fetchNetworkVisiblePosts(sb: SupabaseClient, userIds: string[], since: string, limit: number) {
  return sb
    .from('profile_posts')
    .select('id, user_id, content, created_at')
    .in('user_id', userIds)
    .eq('is_public', true)
    .neq('moderation_status', 'rejected')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);
}

export async function fetchNetworkEventParticipations(sb: SupabaseClient, userIds: string[], since: string, limit: number) {
  return sb
    .from('global_event_participants')
    .select('event_id, user_id, registered_at')
    .in('user_id', userIds)
    .gte('registered_at', since)
    .order('registered_at', { ascending: false })
    .limit(limit);
}
