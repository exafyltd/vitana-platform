/**
 * orb-tools/p0-gap-tools.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in orb-tools/p0-gap-tools.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param) — tools receive their client per-call, not a module-level
 * singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== user_follows ====================

export async function fetchFollowRow(sb: SupabaseClient, followerId: string, followingId: string) {
  return sb.from('user_follows').select('id').eq('follower_id', followerId).eq('following_id', followingId).maybeSingle();
}

export async function insertFollow(sb: SupabaseClient, followerId: string, followingId: string) {
  return sb.from('user_follows').insert({ follower_id: followerId, following_id: followingId });
}

export async function deleteFollow(sb: SupabaseClient, followerId: string, followingId: string) {
  return sb.from('user_follows').delete().eq('follower_id', followerId).eq('following_id', followingId);
}

// ==================== user_notifications ====================

export async function fetchRecentNotifications(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb
    .from('user_notifications')
    .select('id, type, title, body, read_at, created_at')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(20);
}

export async function markNotificationsRead(sb: SupabaseClient, userId: string, tenantId: string, nowIso: string, titleReference: string | null) {
  let query = sb
    .from('user_notifications')
    .update({ read_at: nowIso })
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .is('read_at', null);
  if (titleReference) query = query.ilike('title', `%${titleReference}%`);
  return query.select('id');
}

// ==================== user_subscriptions ====================

export async function fetchUserSubscription(sb: SupabaseClient, userId: string, tenantId: string | null) {
  let query = sb.from('user_subscriptions').select('plan_key, status, current_period_end').eq('user_id', userId);
  if (tenantId) query = query.eq('tenant_id', tenantId);
  return query.maybeSingle();
}

// ==================== profiles ====================

export async function updateOwnProfile(sb: SupabaseClient, userId: string, updates: Record<string, string>) {
  return sb.from('profiles').update(updates).eq('user_id', userId);
}

// ==================== media_uploads (podcasts) ====================

export async function searchApprovedPodcasts(sb: SupabaseClient, orPattern: string | null) {
  let q = sb
    .from('media_uploads')
    .select('id, title, description, file_url, thumbnail_url, duration, podcast_metadata(host_name, series_name)')
    .eq('status', 'approved')
    .eq('is_public', true)
    .eq('media_type', 'podcast');
  if (orPattern) q = q.or(`title.ilike.${orPattern},description.ilike.${orPattern}`);
  return q.order('plays_count', { ascending: false }).limit(5);
}

// ==================== profile_posts ====================

export async function fetchRecentPublicPostsByAuthor(sb: SupabaseClient, authorUserId: string) {
  return sb
    .from('profile_posts')
    .select('id, user_id, content, created_at')
    .eq('user_id', authorUserId)
    .eq('is_public', true)
    .order('created_at', { ascending: false })
    .limit(5);
}

// ==================== profile_post_likes ====================

export async function fetchPostLikeRow(sb: SupabaseClient, postId: string, userId: string) {
  return sb.from('profile_post_likes').select('id').eq('post_id', postId).eq('user_id', userId).maybeSingle();
}

export async function insertPostLike(sb: SupabaseClient, postId: string, userId: string) {
  return sb.from('profile_post_likes').insert({ post_id: postId, user_id: userId });
}

// ==================== profile_post_comments ====================

export async function insertPostComment(sb: SupabaseClient, postId: string, userId: string, content: string) {
  return sb.from('profile_post_comments').insert({ post_id: postId, user_id: userId, content });
}
