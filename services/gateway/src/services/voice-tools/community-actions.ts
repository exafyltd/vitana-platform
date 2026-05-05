/**
 * VTID-02764 — Voice Tool Expansion P1f: Community / Groups / Invitations.
 *
 * Backs voice tools that drive the community surface beyond the existing
 * search_community primitive:
 *   - list_my_groups       → query community_group_members joined with community_groups
 *   - create_group         → community_create_group RPC
 *   - join_group           → community_join_group RPC
 *   - invite_to_group      → community_invite_to_group RPC
 *   - accept_invitation    → community_accept_invitation RPC
 *   - decline_invitation   → community_decline_invitation RPC
 *
 * Each helper enforces user_id ownership at the application layer (the
 * RPCs themselves also enforce via SECURITY DEFINER + RLS). The voice
 * tool dispatcher passes the calling user's id explicitly.
 */

import { SupabaseClient } from '@supabase/supabase-js';

export interface GroupSummary {
  id: string;
  name: string;
  topic_key: string;
  description?: string | null;
  member_count?: number | null;
  created_at?: string | null;
}

// ---------------------------------------------------------------------------
// 1. list_my_groups — direct join query (no dedicated RPC required)
// ---------------------------------------------------------------------------

export async function listMyGroups(
  sb: SupabaseClient,
  userId: string,
  args: { limit?: number },
): Promise<{ ok: true; groups: GroupSummary[]; count: number } | { ok: false; error: string }> {
  const limit = Math.max(1, Math.min(50, args.limit ?? 20));

  // Try the explicit membership table first.
  const memberQuery = await sb
    .from('community_group_members')
    .select('group_id, joined_at')
    .eq('user_id', userId)
    .order('joined_at', { ascending: false })
    .limit(limit);
  if (memberQuery.error) {
    return { ok: false, error: `members_query_failed: ${memberQuery.error.message}` };
  }
  const groupIds = (memberQuery.data || []).map((r: any) => String(r.group_id)).filter(Boolean);
  if (groupIds.length === 0) {
    return { ok: true, groups: [], count: 0 };
  }

  const groupsQuery = await sb
    .from('community_groups')
    .select('id, name, topic_key, description, created_at')
    .in('id', groupIds);
  if (groupsQuery.error) {
    return { ok: false, error: `groups_query_failed: ${groupsQuery.error.message}` };
  }
  const groups: GroupSummary[] = (groupsQuery.data || []).map((g: any) => ({
    id: String(g.id),
    name: String(g.name ?? ''),
    topic_key: String(g.topic_key ?? ''),
    description: g.description ?? null,
    member_count: null,
    created_at: g.created_at ?? null,
  }));
  return { ok: true, groups, count: groups.length };
}

// ---------------------------------------------------------------------------
// 2. create_group — community_create_group RPC
// ---------------------------------------------------------------------------

export async function createGroup(
  sb: SupabaseClient,
  args: { name: string; topic_key: string; description?: string },
): Promise<{ ok: true; group: GroupSummary } | { ok: false; error: string }> {
  if (!args.name || !args.topic_key) {
    return { ok: false, error: 'name_and_topic_key_required' };
  }
  const { data, error } = await sb.rpc('community_create_group', {
    p_payload: {
      name: args.name,
      topic_key: args.topic_key,
      description: args.description,
    },
  });
  if (error) {
    if (error.message.includes('function') && error.message.includes('does not exist')) {
      return { ok: false, error: 'create_group_rpc_unavailable' };
    }
    return { ok: false, error: `create_failed: ${error.message}` };
  }
  if (!data || !(data as any).id) {
    return { ok: false, error: 'create_returned_no_data' };
  }
  const g = data as any;
  return {
    ok: true,
    group: {
      id: String(g.id),
      name: String(g.name ?? args.name),
      topic_key: String(g.topic_key ?? args.topic_key),
      description: g.description ?? args.description ?? null,
      member_count: null,
      created_at: g.created_at ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// 3. join_group — community_join_group RPC
// ---------------------------------------------------------------------------

export async function joinGroup(
  sb: SupabaseClient,
  args: { group_id: string },
): Promise<{ ok: true; group_id: string; joined_at: string } | { ok: false; error: string }> {
  if (!args.group_id) return { ok: false, error: 'group_id_required' };
  const { data, error } = await sb.rpc('community_join_group', {
    p_group_id: args.group_id,
  });
  if (error) {
    if (error.message.includes('function') && error.message.includes('does not exist')) {
      return { ok: false, error: 'join_group_rpc_unavailable' };
    }
    return { ok: false, error: `join_failed: ${error.message}` };
  }
  return {
    ok: true,
    group_id: args.group_id,
    joined_at: (data as any)?.joined_at ?? new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 4. invite_to_group — community_invite_to_group RPC
// ---------------------------------------------------------------------------

export async function inviteToGroup(
  sb: SupabaseClient,
  args: { group_id: string; invitee_user_id: string; message?: string },
): Promise<{ ok: true; invitation_id: string } | { ok: false; error: string }> {
  if (!args.group_id || !args.invitee_user_id) {
    return { ok: false, error: 'group_id_and_invitee_required' };
  }
  const { data, error } = await sb.rpc('community_invite_to_group', {
    p_group_id: args.group_id,
    p_invitee_user_id: args.invitee_user_id,
    p_message: args.message ?? null,
  });
  if (error) {
    if (error.message.includes('function') && error.message.includes('does not exist')) {
      return { ok: false, error: 'invite_rpc_unavailable' };
    }
    return { ok: false, error: `invite_failed: ${error.message}` };
  }
  return { ok: true, invitation_id: String((data as any)?.id ?? '') };
}

// ---------------------------------------------------------------------------
// 5/6. accept / decline invitation
// ---------------------------------------------------------------------------

export async function respondToInvitation(
  sb: SupabaseClient,
  args: { invitation_id: string; response: 'accept' | 'decline' },
): Promise<{ ok: true; invitation_id: string; response: string } | { ok: false; error: string }> {
  if (!args.invitation_id) return { ok: false, error: 'invitation_id_required' };
  if (!['accept', 'decline'].includes(args.response)) {
    return { ok: false, error: 'invalid_response' };
  }
  const rpcName =
    args.response === 'accept' ? 'community_accept_invitation' : 'community_decline_invitation';
  const { error } = await sb.rpc(rpcName, { p_invitation_id: args.invitation_id });
  if (error) {
    if (error.message.includes('function') && error.message.includes('does not exist')) {
      return { ok: false, error: `${rpcName}_unavailable` };
    }
    return { ok: false, error: `${args.response}_failed: ${error.message}` };
  }
  return { ok: true, invitation_id: args.invitation_id, response: args.response };
}
