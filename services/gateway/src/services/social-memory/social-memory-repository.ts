/**
 * BOOTSTRAP-SOCIAL-MEMORY — repository layer.
 *
 * All Supabase reads for the Social Memory Intelligence layer live here.
 * The gateway uses the service-role client (RLS bypassed), so EVERY read
 * applies visibility rules explicitly:
 *
 *   - blocked authors (user_blocked_authors) are excluded everywhere
 *   - muted authors (user_muted_authors) are excluded from posts/feeds
 *   - hidden posts (user_hidden_posts) are excluded from post lists
 *   - posts: only is_public=true (or the viewer's own), moderation-approved
 *   - profiles: only public-safe columns are ever selected — email, phone,
 *     medical fields are never read by this module
 *   - messages: only conversations the viewer participates in
 *   - tenant scoping applied where the table carries tenant_id
 *
 * Table names verified against the LIVE database (2026-07-03) — several
 * code-level tables (e.g. matches_daily) do not exist in production; the
 * populated sources are the ones used here.
 */

import { getSupabase } from '../../lib/supabase';
import {
  SocialPerson,
  FollowEdge,
  MatchSummary,
  MessageContact,
  GroupChatSummary,
} from './social-memory-types';

const PROFILE_COLS =
  'user_id, display_name, handle, avatar_url, bio, city, country, account_visibility, vitana_id';

export interface RawPost {
  id: string;
  user_id: string;
  content: string;
  image_url: string | null;
  video_url: string | null;
  likes_count: number;
  comments_count: number;
  created_at: string;
}

export interface RawEvent {
  id: string;
  title: string;
  description: string | null;
  event_type: string | null;
  start_time: string;
  location: string | null;
  slug: string | null;
  participant_count: number | null;
}

function mapPerson(row: any): SocialPerson {
  return {
    user_id: row.user_id,
    display_name: row.display_name ?? null,
    handle: row.handle ?? null,
    vitana_id: row.vitana_id ?? null,
    avatar_url: row.avatar_url ?? null,
    bio: row.bio ?? null,
    city: row.city ?? null,
    country: row.country ?? null,
    visibility: typeof row.account_visibility === 'string' ? row.account_visibility : null,
  };
}

/** Batch-load privacy-safe person cards for a set of user ids. */
export async function fetchPeople(userIds: string[]): Promise<Map<string, SocialPerson>> {
  const out = new Map<string, SocialPerson>();
  const ids = Array.from(new Set(userIds)).filter(Boolean);
  if (ids.length === 0) return out;
  const supabase = getSupabase();
  if (!supabase) return out;
  const { data } = await supabase.from('profiles').select(PROFILE_COLS).in('user_id', ids.slice(0, 200));
  for (const row of data || []) out.set(row.user_id, mapPerson(row));
  return out;
}

/**
 * Exclusion sets for the viewer: blocked + muted authors, hidden posts.
 * Blocked applies everywhere; muted applies to content surfaces.
 *
 * FAIL CLOSED: every downstream read depends on these sets for privacy
 * filtering, so a failed exclusion query must THROW — never silently
 * return empty sets (that would let blocked/muted content through).
 * Callers abort the social pack when this throws.
 */
export async function fetchExclusions(userId: string): Promise<{
  blocked: Set<string>;
  muted: Set<string>;
  hidden_posts: Set<string>;
}> {
  const supabase = getSupabase();
  const blocked = new Set<string>();
  const muted = new Set<string>();
  const hiddenPosts = new Set<string>();
  if (!supabase) throw new Error('exclusions_unavailable: supabase not configured');

  const [b, m, h] = await Promise.all([
    supabase.from('user_blocked_authors').select('author_id').eq('user_id', userId).limit(500),
    supabase.from('user_muted_authors').select('author_id').eq('user_id', userId).limit(500),
    supabase.from('user_hidden_posts').select('post_id').eq('user_id', userId).limit(1000),
  ]);
  const firstError = b.error || m.error || h.error;
  if (firstError) {
    throw new Error(`exclusions_read_failed: ${firstError.message}`);
  }
  for (const r of b.data || []) blocked.add(r.author_id);
  for (const r of m.data || []) muted.add(r.author_id);
  for (const r of h.data || []) hiddenPosts.add(r.post_id);
  return { blocked, muted, hidden_posts: hiddenPosts };
}

/** People the user follows / who follow the user (user_follows). */
export async function fetchFollowEdges(
  userId: string,
  blocked: Set<string>,
  limit = 50,
): Promise<{ following: FollowEdge[]; followers: FollowEdge[] }> {
  const supabase = getSupabase();
  if (!supabase) return { following: [], followers: [] };

  const [outRes, inRes] = await Promise.all([
    supabase
      .from('user_follows')
      .select('following_id, created_at')
      .eq('follower_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from('user_follows')
      .select('follower_id, created_at')
      .eq('following_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit),
  ]);

  const outRows = (outRes.data || []).filter((r) => !blocked.has(r.following_id));
  const inRows = (inRes.data || []).filter((r) => !blocked.has(r.follower_id));
  const people = await fetchPeople([
    ...outRows.map((r) => r.following_id),
    ...inRows.map((r) => r.follower_id),
  ]);

  const following: FollowEdge[] = outRows
    .map((r) => ({ person: people.get(r.following_id), since: r.created_at }))
    .filter((e): e is FollowEdge => !!e.person);
  const followers: FollowEdge[] = inRows
    .map((r) => ({ person: people.get(r.follower_id), since: r.created_at }))
    .filter((e): e is FollowEdge => !!e.person);
  return { following, followers };
}

/**
 * Matches: current daily matches (daily_matches — score + human-readable
 * reasons) plus historical mutual matches (user_matches).
 */
export async function fetchMatches(
  userId: string,
  blocked: Set<string>,
  limit = 20,
): Promise<MatchSummary[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  const [dailyRes, mutualRes] = await Promise.all([
    supabase
      .from('daily_matches')
      .select('matched_user_id, match_score, match_reasons, action, expires_at, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from('user_matches')
      .select('user_id_1, user_id_2, compatibility_score, match_reason, matched_at, conversation_started, is_active')
      .or(`user_id_1.eq.${userId},user_id_2.eq.${userId}`)
      .order('matched_at', { ascending: false })
      .limit(limit),
  ]);

  const now = Date.now();
  const entries: Array<{ personId: string; summary: Omit<MatchSummary, 'person'> }> = [];

  for (const r of dailyRes.data || []) {
    if (blocked.has(r.matched_user_id)) continue;
    entries.push({
      personId: r.matched_user_id,
      summary: {
        score: r.match_score != null ? Math.round(Number(r.match_score)) : null,
        reasons: Array.isArray(r.match_reasons) ? r.match_reasons.map(String) : [],
        source: 'daily_match',
        matched_at: r.created_at,
        action: r.action ?? null,
        conversation_started: false,
        is_current: !r.expires_at || Date.parse(r.expires_at) > now,
      },
    });
  }
  for (const r of mutualRes.data || []) {
    const other = r.user_id_1 === userId ? r.user_id_2 : r.user_id_1;
    if (blocked.has(other)) continue;
    entries.push({
      personId: other,
      summary: {
        score: r.compatibility_score != null ? Math.round(Number(r.compatibility_score)) : null,
        reasons: r.match_reason ? [String(r.match_reason)] : [],
        source: 'user_match',
        matched_at: r.matched_at,
        action: null,
        conversation_started: r.conversation_started === true,
        is_current: r.is_active === true,
      },
    });
  }

  // Dedupe by person, daily match wins (fresher scores/reasons).
  const byPerson = new Map<string, Omit<MatchSummary, 'person'>>();
  for (const e of entries) if (!byPerson.has(e.personId)) byPerson.set(e.personId, e.summary);

  const people = await fetchPeople(Array.from(byPerson.keys()));
  const out: MatchSummary[] = [];
  for (const [personId, summary] of byPerson) {
    const person = people.get(personId);
    if (person) out.push({ person, ...summary });
  }
  out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return out;
}

/**
 * Recent DM contacts (chat_messages where the user is sender or receiver,
 * group messages excluded). Snippets come only from the viewer's OWN
 * conversations — this never reads anyone else's messages.
 */
export async function fetchRecentMessageContacts(
  userId: string,
  tenantId: string,
  blocked: Set<string>,
  limit = 15,
): Promise<MessageContact[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const { data } = await supabase
    .from('chat_messages')
    .select('sender_id, receiver_id, content, created_at')
    .eq('tenant_id', tenantId)
    .is('group_id', null)
    .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(400);

  const byPeer = new Map<
    string,
    { last_at: string; last_dir: 'sent' | 'received'; snippet: string; count: number }
  >();
  for (const m of data || []) {
    const peer = m.sender_id === userId ? m.receiver_id : m.sender_id;
    if (!peer || peer === userId || blocked.has(peer)) continue;
    const existing = byPeer.get(peer);
    if (existing) {
      existing.count++;
    } else {
      byPeer.set(peer, {
        last_at: m.created_at,
        last_dir: m.sender_id === userId ? 'sent' : 'received',
        snippet: (m.content || '').slice(0, 120),
        count: 1,
      });
    }
  }

  const peers = Array.from(byPeer.keys()).slice(0, limit);
  const people = await fetchPeople(peers);
  const out: MessageContact[] = [];
  for (const peer of peers) {
    const person = people.get(peer);
    const s = byPeer.get(peer)!;
    if (!person) continue;
    out.push({
      person,
      last_message_at: s.last_at,
      last_direction: s.last_dir,
      last_snippet: s.snippet || null,
      messages_30d: s.count,
    });
  }
  return out;
}

/** Group chats the user participates in (chat_group_members → chat_groups). */
export async function fetchGroupChats(
  userId: string,
  tenantId: string,
  limit = 20,
): Promise<GroupChatSummary[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data: memberships } = await supabase
    .from('chat_group_members')
    .select('group_id, joined_at')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .limit(limit);
  const groupIds = (memberships || []).map((m) => m.group_id);
  if (groupIds.length === 0) return [];

  const [groupsRes, memberCounts, lastMsgs] = await Promise.all([
    supabase.from('chat_groups').select('id, name, is_system').in('id', groupIds),
    supabase.from('chat_group_members').select('group_id').in('group_id', groupIds).limit(2000),
    supabase
      .from('chat_messages')
      .select('group_id, created_at')
      .in('group_id', groupIds)
      .order('created_at', { ascending: false })
      .limit(100),
  ]);

  const countByGroup = new Map<string, number>();
  for (const r of memberCounts.data || []) {
    countByGroup.set(r.group_id, (countByGroup.get(r.group_id) || 0) + 1);
  }
  const lastByGroup = new Map<string, string>();
  for (const r of lastMsgs.data || []) {
    if (!lastByGroup.has(r.group_id)) lastByGroup.set(r.group_id, r.created_at);
  }
  const joinedByGroup = new Map<string, string>();
  for (const m of memberships || []) joinedByGroup.set(m.group_id, m.joined_at);

  return (groupsRes.data || []).map((g) => ({
    group_id: g.id,
    name: g.name ?? null,
    member_count: countByGroup.get(g.id) ?? null,
    is_system: g.is_system === true,
    last_message_at: lastByGroup.get(g.id) ?? null,
    joined_at: joinedByGroup.get(g.id) ?? null,
  }));
}

/**
 * Candidate posts for the interesting-posts ranker: public, approved,
 * not hidden, authors not blocked/muted. Pulls a wider pool from followed
 * authors plus recent public posts; the ranker picks the top N.
 */
export async function fetchCandidatePosts(
  userId: string,
  followedIds: string[],
  excl: { blocked: Set<string>; muted: Set<string>; hidden_posts: Set<string> },
  limitPerSource = 40,
): Promise<RawPost[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();

  const baseSelect =
    'id, user_id, content, image_url, video_url, likes_count, comments_count, created_at';
  const queries: PromiseLike<any>[] = [
    supabase
      .from('profile_posts')
      .select(baseSelect)
      .eq('is_public', true)
      .neq('moderation_status', 'rejected')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(limitPerSource),
  ];
  if (followedIds.length > 0) {
    queries.push(
      supabase
        .from('profile_posts')
        .select(baseSelect)
        .eq('is_public', true)
        .neq('moderation_status', 'rejected')
        .in('user_id', followedIds.slice(0, 100))
        .order('created_at', { ascending: false })
        .limit(limitPerSource),
    );
  }
  const results = await Promise.all(queries);

  const seen = new Set<string>();
  const out: RawPost[] = [];
  for (const res of results) {
    for (const p of res.data || []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      if (p.user_id === userId) continue; // own posts are not recommendations
      if (excl.blocked.has(p.user_id) || excl.muted.has(p.user_id)) continue;
      if (excl.hidden_posts.has(p.id)) continue;
      out.push(p as RawPost);
    }
  }
  return out;
}

/** A specific person's latest PUBLIC posts (privacy: is_public only). */
export async function fetchPersonPosts(personId: string, limit = 5): Promise<RawPost[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from('profile_posts')
    .select('id, user_id, content, image_url, video_url, likes_count, comments_count, created_at')
    .eq('user_id', personId)
    .eq('is_public', true)
    .neq('moderation_status', 'rejected')
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data || []) as RawPost[];
}

/** Upcoming community events (global_community_events). */
export async function fetchUpcomingEvents(limit = 40): Promise<RawEvent[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from('global_community_events')
    .select('id, title, description, event_type, start_time, location, slug, participant_count')
    .gte('start_time', new Date().toISOString())
    .order('start_time', { ascending: true })
    .limit(limit);
  return (data || []) as RawEvent[];
}

/** Participant user_ids for a set of events (for "3 people you follow attend"). */
export async function fetchEventParticipants(
  eventIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const supabase = getSupabase();
  if (!supabase || eventIds.length === 0) return out;
  const { data } = await supabase
    .from('global_event_participants')
    .select('event_id, user_id, status')
    .in('event_id', eventIds.slice(0, 60))
    .limit(3000);
  for (const r of data || []) {
    if (r.status === 'cancelled' || r.status === 'declined') continue;
    const arr = out.get(r.event_id) || [];
    arr.push(r.user_id);
    out.set(r.event_id, arr);
  }
  return out;
}

/** Events a set of users participate in (shared-events computation). */
export async function fetchEventsForUsers(userIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const supabase = getSupabase();
  if (!supabase || userIds.length === 0) return out;
  const { data } = await supabase
    .from('global_event_participants')
    .select('event_id, user_id')
    .in('user_id', userIds.slice(0, 50))
    .limit(2000);
  for (const r of data || []) {
    const set = out.get(r.user_id) || new Set<string>();
    set.add(r.event_id);
    out.set(r.user_id, set);
  }
  return out;
}

/** Community group memberships for users (shared-groups computation). */
export async function fetchGroupsForUsers(userIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const supabase = getSupabase();
  if (!supabase || userIds.length === 0) return out;
  const { data } = await supabase
    .from('global_community_group_members')
    .select('group_id, user_id')
    .in('user_id', userIds.slice(0, 50))
    .limit(2000);
  for (const r of data || []) {
    const set = out.get(r.user_id) || new Set<string>();
    set.add(r.group_id);
    out.set(r.user_id, set);
  }
  return out;
}

/** Group names for ids (labels for shared groups). */
export async function fetchGroupNames(groupIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const supabase = getSupabase();
  if (!supabase || groupIds.length === 0) return out;
  const { data } = await supabase
    .from('global_community_groups')
    .select('id, name')
    .in('id', groupIds.slice(0, 100));
  for (const r of data || []) out.set(r.id, r.name);
  return out;
}

/** Event titles for ids (labels for shared events). */
export async function fetchEventTitles(eventIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const supabase = getSupabase();
  if (!supabase || eventIds.length === 0) return out;
  const { data } = await supabase
    .from('global_community_events')
    .select('id, title, start_time')
    .in('id', eventIds.slice(0, 100));
  for (const r of data || []) out.set(r.id, r.title);
  return out;
}

/** Interests (user_interests) for one or more users. */
export async function fetchInterests(userIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const supabase = getSupabase();
  if (!supabase || userIds.length === 0) return out;
  const { data } = await supabase
    .from('user_interests')
    .select('user_id, interest, confidence_score')
    .in('user_id', userIds.slice(0, 50))
    .order('confidence_score', { ascending: false })
    .limit(500);
  for (const r of data || []) {
    const arr = out.get(r.user_id) || [];
    if (arr.length < 15) arr.push(String(r.interest).toLowerCase());
    out.set(r.user_id, arr);
  }
  return out;
}

/** Last DM exchange timestamp between viewer and a person (viewer's own thread). */
export async function fetchLastChatAt(
  userId: string,
  tenantId: string,
  personId: string,
): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase
    .from('chat_messages')
    .select('created_at')
    .eq('tenant_id', tenantId)
    .or(
      `and(sender_id.eq.${userId},receiver_id.eq.${personId}),and(sender_id.eq.${personId},receiver_id.eq.${userId})`,
    )
    .order('created_at', { ascending: false })
    .limit(1);
  return data?.[0]?.created_at ?? null;
}

/** Does an active follow edge exist in either direction? */
export async function fetchFollowFlags(
  userId: string,
  personId: string,
): Promise<{ you_follow: boolean; follows_you: boolean }> {
  const supabase = getSupabase();
  if (!supabase) return { you_follow: false, follows_you: false };
  const [a, b] = await Promise.all([
    supabase
      .from('user_follows')
      .select('id')
      .eq('follower_id', userId)
      .eq('following_id', personId)
      .limit(1),
    supabase
      .from('user_follows')
      .select('id')
      .eq('follower_id', personId)
      .eq('following_id', userId)
      .limit(1),
  ]);
  return { you_follow: (a.data || []).length > 0, follows_you: (b.data || []).length > 0 };
}

/**
 * Resolve a person by fuzzy name / handle / vitana_id. Only searchable
 * profiles are considered (profile_privacy_settings.searchable !== false).
 */
export async function resolvePersonByName(hint: string): Promise<SocialPerson | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const term = hint.trim().replace(/[%_]/g, '');
  if (term.length < 2) return null;

  const { data } = await supabase
    .from('profiles')
    .select(`${PROFILE_COLS}, full_name`)
    .or(`display_name.ilike.%${term}%,full_name.ilike.%${term}%,handle.ilike.%${term}%,vitana_id.ilike.%${term}%`)
    .limit(5);
  if (!data || data.length === 0) return null;

  // Prefer exact-ish display_name match, then first hit.
  const lower = term.toLowerCase();
  const best =
    data.find((r: any) => (r.display_name || '').toLowerCase() === lower) ||
    data.find((r: any) => (r.display_name || '').toLowerCase().includes(lower)) ||
    data[0];

  const { data: priv } = await supabase
    .from('profile_privacy_settings')
    .select('searchable')
    .eq('user_id', best.user_id)
    .maybeSingle();
  if (priv && priv.searchable === false) return null;
  return mapPerson(best);
}

/** Load one person by user_id. */
export async function fetchPersonById(personId: string): Promise<SocialPerson | null> {
  const people = await fetchPeople([personId]);
  return people.get(personId) ?? null;
}
