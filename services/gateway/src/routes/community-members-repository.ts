// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/community-members.ts — zero coverage
// today.
/**
 * routes/community-members.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in community-members.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 *
 * `buildMembersListQuery` preserves the source's conditional sort/
 * cursor filter chain (newest/oldest/name) — the caller still applies
 * `.limit()` and awaits.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchHiddenCommunityProfileUserIds(sb: SupabaseClient) {
  return sb.from('global_community_profiles').select('user_id').eq('is_visible', false);
}

export async function countProfilesExcludingSelf(sb: SupabaseClient, selfUserId: string) {
  return sb.from('profiles').select('user_id', { count: 'exact', head: true }).neq('user_id', selfUserId);
}

export async function buildMembersListQuery(
  sb: SupabaseClient,
  args: { selfUserId: string; sort: 'newest' | 'oldest' | 'name'; cursor: string | null; limit: number },
) {
  let q = sb
    .from('profiles')
    .select('user_id, vitana_id, registration_seq, display_name, full_name, avatar_url, location, dance_preferences, created_at')
    .neq('user_id', args.selfUserId);

  if (args.sort === 'newest') {
    q = q.order('registration_seq', { ascending: false, nullsFirst: false });
    if (args.cursor) q = q.lt('registration_seq', parseInt(args.cursor, 10));
  } else if (args.sort === 'oldest') {
    q = q.order('registration_seq', { ascending: true, nullsFirst: true });
    if (args.cursor) q = q.gt('registration_seq', parseInt(args.cursor, 10));
  } else {
    q = q.order('display_name', { ascending: true });
    if (args.cursor) q = q.gt('display_name', args.cursor);
  }

  return q.limit(args.limit);
}
