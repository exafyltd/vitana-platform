/**
 * Community Groups (VTID-02764) + Events/RSVP (VTID-02774) voice tools.
 *
 * Groups tools operate on the REAL, populated groups schema —
 * global_community_groups / global_community_group_members (see the
 * "never-deployed VTID-01084 community_groups" note in
 * routes/community.ts for why NOT community_groups/community_memberships)
 * — plus community_group_invitations for the invite/accept/decline flow
 * (its DB trigger sends the recipient a notification on insert).
 * Events tools operate on global_community_events +
 * global_event_participants (status='attending', UNIQUE(event_id,user_id),
 * participant_count kept in sync — the exact contract the frontend's
 * useEventParticipation hook uses), and live_rooms (tenant-scoped) for
 * join_live_room, which returns the same navigate orb_directive shape
 * search_community / search_events use so the UI opens the room screen.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';

type Handler = (args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient) => Promise<OrbToolResult>;

const VTID_GROUPS = 'VTID-02764';
const VTID_EVENTS = 'VTID-02774';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** ok:false when there is no authenticated user — these tools touch user data. */
function authGate(tool: string, id: OrbToolIdentity): OrbToolResult | null {
  if (!id.user_id) {
    return { ok: false, error: `${tool} requires an authenticated user.` };
  }
  return null;
}

/** "Tue, Jul 8, 6:00 PM" — English; the LLM translates when speaking DE. */
function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return 'time to be announced';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return 'time to be announced';
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function memberCountPhrase(n: number | null | undefined): string {
  const c = Number(n) || 0;
  return `${c} member${c === 1 ? '' : 's'}`;
}

function navDirective(
  screen_id: string,
  route: string,
  title: string,
  reason: string,
  vtid: string,
): Record<string, unknown> {
  return { type: 'orb_directive', directive: 'navigate', screen_id, route, title, reason, vtid };
}

/** tenant backfill from app_users when the voice session carries a null tenant. */
async function resolveTenantId(id: OrbToolIdentity, sb: SupabaseClient): Promise<string | null> {
  if (id.tenant_id) return id.tenant_id;
  try {
    const { data } = await sb
      .from('app_users')
      .select('tenant_id')
      .eq('user_id', id.user_id)
      .maybeSingle();
    return (data as { tenant_id?: string | null } | null)?.tenant_id ?? null;
  } catch {
    return null;
  }
}

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  member_count: number | null;
  is_public: boolean | null;
}

type GroupResolution =
  | { kind: 'one'; group: GroupRow }
  | { kind: 'many'; groups: GroupRow[] }
  | { kind: 'none'; query: string }
  | { kind: 'error'; message: string };

const GROUP_COLS = 'id, name, description, member_count, is_public';

/** Resolve a group by UUID or fuzzy name against the live global groups schema. */
async function resolveGroup(sb: SupabaseClient, rawId: unknown, rawQuery: unknown): Promise<GroupResolution> {
  const groupId = String(rawId ?? '').trim();
  const query = String(rawQuery ?? '').trim();

  if (UUID_RE.test(groupId)) {
    const { data, error } = await sb
      .from('global_community_groups')
      .select(GROUP_COLS)
      .eq('id', groupId)
      .eq('status', 'approved')
      .maybeSingle();
    if (error) return { kind: 'error', message: error.message };
    if (!data) return { kind: 'none', query: groupId };
    return { kind: 'one', group: data as GroupRow };
  }

  if (!query) return { kind: 'none', query: '' };

  const { data, error } = await sb
    .from('global_community_groups')
    .select(GROUP_COLS)
    .eq('status', 'approved')
    .ilike('name', `%${query}%`)
    .order('member_count', { ascending: false })
    .limit(5);
  if (error) return { kind: 'error', message: error.message };
  const groups = (data as GroupRow[]) ?? [];
  if (groups.length === 0) return { kind: 'none', query };
  if (groups.length === 1) return { kind: 'one', group: groups[0] };
  const exact = groups.find((g) => g.name.toLowerCase() === query.toLowerCase());
  if (exact) return { kind: 'one', group: exact };
  return { kind: 'many', groups };
}

/** Idempotent membership insert (unique-violation raced join = success). */
async function ensureMembership(
  sb: SupabaseClient,
  groupId: string,
  userId: string,
  role: string,
): Promise<{ already: boolean; error?: string }> {
  const { data: existing } = await sb
    .from('global_community_group_members')
    .select('id')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .maybeSingle();
  if (existing) return { already: true };
  const { error } = await sb
    .from('global_community_group_members')
    .insert({ group_id: groupId, user_id: userId, role });
  if (error) {
    if ((error as { code?: string }).code === '23505') return { already: true };
    return { already: false, error: error.message };
  }
  return { already: false };
}

/**
 * Resolve a spoken member name to a user_id via the platform's canonical
 * resolver RPC (same as tool_resolve_recipient / tool_send_chat_message).
 */
async function resolveMember(
  sb: SupabaseClient,
  actorUserId: string,
  spoken: string,
): Promise<
  | { kind: 'one'; user_id: string; display_name: string }
  | { kind: 'ambiguous'; names: string[] }
  | { kind: 'none' }
  | { kind: 'error'; message: string }
> {
  const { data, error } = await sb.rpc('resolve_recipient_candidates', {
    p_actor: actorUserId,
    p_token: spoken,
    p_limit: 3,
    p_global: true,
  });
  if (error) return { kind: 'error', message: error.message };
  const candidates = (data || []) as Array<{
    user_id: string;
    vitana_id: string | null;
    display_name: string | null;
    score: number;
  }>;
  if (candidates.length === 0) return { kind: 'none' };
  const top = candidates[0];
  const topScore = Number(top.score) || 0;
  const second = candidates[1] ? Number(candidates[1].score) || 0 : 0;
  const ambiguous = topScore < 0.85 || (candidates.length > 1 && second / Math.max(topScore, 0.0001) > 0.85);
  if (ambiguous) {
    return {
      kind: 'ambiguous',
      names: candidates.slice(0, 3).map((c) => c.display_name || c.vitana_id || c.user_id),
    };
  }
  return { kind: 'one', user_id: top.user_id, display_name: top.display_name || top.vitana_id || 'that member' };
}

// ---------------------------------------------------------------------------
// list_my_groups (VTID-02764)
// ---------------------------------------------------------------------------

export async function tool_list_my_groups(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('list_my_groups', id);
  if (gate) return gate;
  try {
    const { data: memberships, error: mErr } = await sb
      .from('global_community_group_members')
      .select('group_id, role, joined_at')
      .eq('user_id', id.user_id)
      .order('joined_at', { ascending: false })
      .limit(25);
    if (mErr) return { ok: false, error: mErr.message };

    const rows = (memberships as Array<{ group_id: string; role: string; joined_at: string }>) ?? [];
    const roleByGroup = new Map(rows.map((r) => [r.group_id, r.role]));

    const found = new Map<string, GroupRow & { role: string }>();
    if (rows.length > 0) {
      const { data: groups, error: gErr } = await sb
        .from('global_community_groups')
        .select(GROUP_COLS)
        .in('id', rows.map((r) => r.group_id));
      if (gErr) return { ok: false, error: gErr.message };
      for (const g of (groups as GroupRow[]) ?? []) {
        found.set(g.id, { ...g, role: roleByGroup.get(g.id) ?? 'member' });
      }
    }

    // Groups the user created count as theirs even without a membership row
    // (mirrors the frontend's useUserGroups merge).
    const { data: created } = await sb
      .from('global_community_groups')
      .select(GROUP_COLS)
      .eq('created_by', id.user_id)
      .eq('status', 'approved');
    for (const g of (created as GroupRow[]) ?? []) {
      if (!found.has(g.id)) found.set(g.id, { ...g, role: 'admin' });
    }

    const myGroups = Array.from(found.values());
    if (myGroups.length === 0) {
      return {
        ok: true,
        result: { groups: [] },
        text: "You're not in any community groups yet. Want me to look for groups that match your interests?",
      };
    }
    const spoken = myGroups
      .slice(0, 8)
      .map((g) => `${g.name} (${memberCountPhrase(g.member_count)}${g.role === 'admin' ? ', you're an admin' : ''})`)
      .join('; ');
    return {
      ok: true,
      result: {
        groups: myGroups.map((g) => ({
          group_id: g.id,
          name: g.name,
          member_count: g.member_count ?? 0,
          role: g.role,
          is_public: g.is_public ?? true,
        })),
      },
      text: `You're in ${myGroups.length} group${myGroups.length === 1 ? '' : 's'}: ${spoken}.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'list_my_groups failed' };
  }
}

// ---------------------------------------------------------------------------
// create_group (VTID-02764)
// ---------------------------------------------------------------------------

export async function tool_create_group(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('create_group', id);
  if (gate) return gate;
  const name = String(args.name ?? '').trim();
  const description = String(args.description ?? '').trim();
  const privacyRaw = String(args.privacy ?? 'public').trim().toLowerCase();
  const isPublic = privacyRaw !== 'private';
  if (!name) {
    return { ok: false, error: 'create_group requires a group name. Ask the user what to call the group.' };
  }
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { needs_confirmation: true, name, privacy: isPublic ? 'public' : 'private', description: description || null },
      text: `Confirm with the user: create a ${isPublic ? 'public' : 'private'} group called "${name}"${description ? ` (${description.slice(0, 80)})` : ''}? When they say yes, call create_group again with confirm:true.`,
    };
  }
  try {
    const { data: group, error } = await sb
      .from('global_community_groups')
      .insert({
        name,
        description: description || null,
        is_public: isPublic,
        created_by: id.user_id,
        status: 'approved',
        member_count: 0,
      })
      .select('id, name')
      .single();
    if (error || !group) {
      return { ok: false, error: error?.message ?? 'group insert failed' };
    }
    const g = group as { id: string; name: string };
    // Creator becomes admin member (DB trigger fallback, same as the UI).
    await ensureMembership(sb, g.id, id.user_id, 'admin');

    const route = `/comm/groups/${encodeURIComponent(g.id)}`;
    return {
      ok: true,
      result: {
        group_id: g.id,
        name: g.name,
        privacy: isPublic ? 'public' : 'private',
        decision: 'auto_nav',
        directive: navDirective('COMM.GROUP_DETAIL', route, g.name, 'create_group created', VTID_GROUPS),
        redirect: { route },
      },
      text: `Done — I created the ${isPublic ? 'public' : 'private'} group "${g.name}" and made you its admin. Opening it now.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'create_group failed' };
  }
}

// ---------------------------------------------------------------------------
// join_group (VTID-02764)
// ---------------------------------------------------------------------------

export async function tool_join_group(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('join_group', id);
  if (gate) return gate;
  const queryLabel = String(args.query ?? args.name ?? '').trim();
  try {
    const resolved = await resolveGroup(sb, args.group_id, queryLabel);
    if (resolved.kind === 'error') return { ok: false, error: resolved.message };
    if (resolved.kind === 'none') {
      return {
        ok: true,
        result: { joined: false },
        text: queryLabel
          ? `I couldn't find a group matching "${queryLabel}". Want me to search the community groups for you?`
          : 'Which group would you like to join? Tell me its name.',
      };
    }
    if (resolved.kind === 'many') {
      const names = resolved.groups.map((g) => `${g.name} (${memberCountPhrase(g.member_count)})`).join(', ');
      return {
        ok: true,
        result: {
          joined: false,
          candidates: resolved.groups.map((g) => ({ group_id: g.id, name: g.name })),
        },
        text: `I found ${resolved.groups.length} groups matching that: ${names}. Which one do you mean?`,
      };
    }

    const group = resolved.group;
    if (group.is_public === false) {
      // Private groups need an invitation — self-join is not allowed.
      return {
        ok: true,
        result: { joined: false, group_id: group.id, name: group.name, private: true },
        text: `"${group.name}" is a private group — you need an invitation from one of its members to join.`,
      };
    }

    const membership = await ensureMembership(sb, group.id, id.user_id, 'member');
    if (membership.error) return { ok: false, error: membership.error };
    if (membership.already) {
      return {
        ok: true,
        result: { joined: false, already_member: true, group_id: group.id, name: group.name },
        text: `You're already a member of "${group.name}".`,
      };
    }

    // Best-effort: fire the same automation event the gateway join route
    // dispatches so the Welcome Squad (AP-0212/AP-0203) can react.
    try {
      const tenantId = id.tenant_id || process.env.DEFAULT_TENANT_ID;
      if (tenantId) {
        const { dispatchEvent } = await import('../automation-executor');
        dispatchEvent(tenantId, 'community.member.joined', {
          group_id: group.id,
          user_id: id.user_id,
        }).catch(() => {});
      }
    } catch {
      /* automation dispatch must never break the voice flow */
    }

    const route = `/comm/groups/${encodeURIComponent(group.id)}`;
    return {
      ok: true,
      result: {
        joined: true,
        group_id: group.id,
        name: group.name,
        decision: 'auto_nav',
        directive: navDirective('COMM.GROUP_DETAIL', route, group.name, 'join_group joined', VTID_GROUPS),
        redirect: { route },
      },
      text: `Welcome to "${group.name}"! You're now a member — opening the group for you.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'join_group failed' };
  }
}

// ---------------------------------------------------------------------------
// invite_to_group (VTID-02764)
// ---------------------------------------------------------------------------

export async function tool_invite_to_group(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('invite_to_group', id);
  if (gate) return gate;
  const memberName = String(args.member_name ?? args.member ?? '').trim();
  const memberUserIdArg = String(args.member_user_id ?? '').trim();
  const message = String(args.message ?? '').trim();
  if (!memberName && !UUID_RE.test(memberUserIdArg)) {
    return { ok: false, error: 'invite_to_group requires the name of the member to invite.' };
  }
  try {
    const tenantId = await resolveTenantId(id, sb);
    if (!tenantId) {
      return { ok: false, error: 'invite_to_group requires an authenticated user.' };
    }

    const resolved = await resolveGroup(sb, args.group_id, String(args.group ?? args.query ?? '').trim());
    if (resolved.kind === 'error') return { ok: false, error: resolved.message };
    if (resolved.kind === 'none') {
      return {
        ok: true,
        result: { invited: false },
        text: 'I couldn\'t find that group. Which group did you want to invite them to?',
      };
    }
    if (resolved.kind === 'many') {
      const names = resolved.groups.map((g) => g.name).join(', ');
      return {
        ok: true,
        result: { invited: false, candidates: resolved.groups.map((g) => ({ group_id: g.id, name: g.name })) },
        text: `I found several groups: ${names}. Which one should I send the invitation for?`,
      };
    }
    const group = resolved.group;

    // Resolve the member (canonical resolver RPC, same as messaging tools).
    let inviteeId = memberUserIdArg;
    let inviteeName = memberName || 'that member';
    if (!UUID_RE.test(inviteeId)) {
      const member = await resolveMember(sb, id.user_id, memberName);
      if (member.kind === 'error') return { ok: false, error: member.message };
      if (member.kind === 'none') {
        return {
          ok: true,
          result: { invited: false },
          text: `I couldn't find anyone named "${memberName}" in the community — they may not have a Vitana account yet.`,
        };
      }
      if (member.kind === 'ambiguous') {
        return {
          ok: true,
          result: { invited: false, candidates: member.names },
          text: `I found a few possible matches: ${member.names.join(', ')}. Which one did you mean?`,
        };
      }
      inviteeId = member.user_id;
      inviteeName = member.display_name;
    }
    if (inviteeId === id.user_id) {
      return { ok: false, error: 'You cannot invite yourself to a group.' };
    }

    // Already a member? Say so instead of inviting.
    const { data: existingMember } = await sb
      .from('global_community_group_members')
      .select('id')
      .eq('group_id', group.id)
      .eq('user_id', inviteeId)
      .maybeSingle();
    if (existingMember) {
      return {
        ok: true,
        result: { invited: false, already_member: true, group_id: group.id },
        text: `${inviteeName} is already a member of "${group.name}".`,
      };
    }

    const { error: insErr } = await sb.from('community_group_invitations').insert({
      tenant_id: tenantId,
      group_id: group.id,
      invited_by: id.user_id,
      invited_user_id: inviteeId,
      status: 'pending',
      message: message || null,
    });
    if (insErr) {
      if ((insErr as { code?: string }).code === '23505') {
        return {
          ok: true,
          result: { invited: false, already_pending: true, group_id: group.id },
          text: `${inviteeName} already has a pending invitation to "${group.name}".`,
        };
      }
      return { ok: false, error: insErr.message };
    }
    return {
      ok: true,
      result: { invited: true, group_id: group.id, invited_user_id: inviteeId },
      text: `Invitation sent — ${inviteeName} will get a notification to join "${group.name}".`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'invite_to_group failed' };
  }
}

// ---------------------------------------------------------------------------
// accept_invitation / decline_invitation (VTID-02764)
// ---------------------------------------------------------------------------

interface InvitationRow {
  id: string;
  group_id: string;
  invited_by: string;
  message: string | null;
  created_at: string;
}

async function fetchPendingInvitations(
  sb: SupabaseClient,
  userId: string,
): Promise<{ invitations: InvitationRow[]; groupNames: Map<string, string> } | { error: string }> {
  const { data, error } = await sb
    .from('community_group_invitations')
    .select('id, group_id, invited_by, message, created_at')
    .eq('invited_user_id', userId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) return { error: error.message };
  const invitations = (data as InvitationRow[]) ?? [];
  const groupNames = new Map<string, string>();
  if (invitations.length > 0) {
    const { data: groups } = await sb
      .from('global_community_groups')
      .select('id, name')
      .in('id', invitations.map((i) => i.group_id));
    for (const g of (groups as Array<{ id: string; name: string }>) ?? []) {
      groupNames.set(g.id, g.name);
    }
  }
  return { invitations, groupNames };
}

async function respondToInvitation(
  action: 'accept' | 'decline',
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const tool = action === 'accept' ? 'accept_invitation' : 'decline_invitation';
  const gate = authGate(tool, id);
  if (gate) return gate;
  try {
    const pending = await fetchPendingInvitations(sb, id.user_id);
    if ('error' in pending) return { ok: false, error: pending.error };
    const { invitations, groupNames } = pending;
    const nameOf = (inv: InvitationRow) => groupNames.get(inv.group_id) ?? 'a group';

    if (invitations.length === 0) {
      return {
        ok: true,
        result: { invitations: [] },
        text: "You don't have any pending group invitations right now.",
      };
    }

    const invitationId = String(args.invitation_id ?? '').trim();
    let target: InvitationRow | undefined;
    if (UUID_RE.test(invitationId)) {
      target = invitations.find((i) => i.id === invitationId);
      if (!target) {
        return {
          ok: true,
          result: { invitations: invitations.map((i) => ({ invitation_id: i.id, group_name: nameOf(i) })) },
          text: 'That invitation is no longer pending. ' +
            `Your pending invitations: ${invitations.map(nameOf).join(', ')}.`,
        };
      }
    } else if (invitations.length === 1) {
      target = invitations[0];
    } else {
      // Try matching a spoken group name before asking.
      const q = String(args.group ?? args.query ?? '').trim().toLowerCase();
      if (q) {
        const matches = invitations.filter((i) => nameOf(i).toLowerCase().includes(q));
        if (matches.length === 1) target = matches[0];
      }
      if (!target) {
        return {
          ok: true,
          result: {
            invitations: invitations.map((i) => ({ invitation_id: i.id, group_id: i.group_id, group_name: nameOf(i) })),
          },
          text: `You have ${invitations.length} pending invitations: ${invitations.map(nameOf).join(', ')}. Which one should I ${action}?`,
        };
      }
    }

    const groupName = nameOf(target);

    if (action === 'decline' && args.confirm !== true) {
      return {
        ok: true,
        result: { needs_confirmation: true, invitation_id: target.id, group_name: groupName },
        text: `Confirm with the user: decline the invitation to "${groupName}"? When they say yes, call decline_invitation again with this invitation_id and confirm:true.`,
      };
    }

    const { error: updErr } = await sb
      .from('community_group_invitations')
      .update({ status: action === 'accept' ? 'accepted' : 'declined', responded_at: new Date().toISOString() })
      .eq('id', target.id)
      .eq('invited_user_id', id.user_id);
    if (updErr) return { ok: false, error: updErr.message };

    if (action === 'decline') {
      return {
        ok: true,
        result: { declined: true, invitation_id: target.id, group_id: target.group_id },
        text: `Okay — I've declined the invitation to "${groupName}".`,
      };
    }

    const membership = await ensureMembership(sb, target.group_id, id.user_id, 'member');
    if (membership.error) return { ok: false, error: membership.error };
    const route = `/comm/groups/${encodeURIComponent(target.group_id)}`;
    return {
      ok: true,
      result: {
        accepted: true,
        invitation_id: target.id,
        group_id: target.group_id,
        decision: 'auto_nav',
        directive: navDirective('COMM.GROUP_DETAIL', route, groupName, 'accept_invitation joined', VTID_GROUPS),
        redirect: { route },
      },
      text: `You've accepted the invitation — welcome to "${groupName}"! Opening the group now.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : `${tool} failed` };
  }
}

export async function tool_accept_invitation(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  return respondToInvitation('accept', args, id, sb);
}

export async function tool_decline_invitation(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  return respondToInvitation('decline', args, id, sb);
}

// ---------------------------------------------------------------------------
// rsvp_event (VTID-02774)
// ---------------------------------------------------------------------------

interface EventRow {
  id: string;
  title: string;
  start_time: string;
  location: string | null;
  participant_count: number | null;
  max_participants: number | null;
}

const EVENT_COLS = 'id, title, start_time, location, participant_count, max_participants';

type EventResolution =
  | { kind: 'one'; event: EventRow }
  | { kind: 'many'; events: EventRow[] }
  | { kind: 'none'; query: string }
  | { kind: 'error'; message: string };

async function resolveUpcomingEvent(sb: SupabaseClient, rawId: unknown, rawQuery: unknown): Promise<EventResolution> {
  const eventId = String(rawId ?? '').trim();
  const query = String(rawQuery ?? '').trim();

  if (UUID_RE.test(eventId)) {
    const { data, error } = await sb
      .from('global_community_events')
      .select(EVENT_COLS)
      .eq('id', eventId)
      .maybeSingle();
    if (error) return { kind: 'error', message: error.message };
    if (!data) return { kind: 'none', query: eventId };
    return { kind: 'one', event: data as EventRow };
  }

  if (!query) return { kind: 'none', query: '' };

  const { data, error } = await sb
    .from('global_community_events')
    .select(EVENT_COLS)
    .gte('start_time', new Date().toISOString())
    .ilike('title', `%${query}%`)
    .order('start_time', { ascending: true })
    .limit(5);
  if (error) return { kind: 'error', message: error.message };
  const events = (data as EventRow[]) ?? [];
  if (events.length === 0) return { kind: 'none', query };
  if (events.length === 1) return { kind: 'one', event: events[0] };
  const exact = events.find((e) => e.title.toLowerCase() === query.toLowerCase());
  if (exact) return { kind: 'one', event: exact };
  return { kind: 'many', events };
}

function speakEventLine(e: EventRow): string {
  return `"${e.title}" on ${fmtWhen(e.start_time)}${e.location ? ` at ${e.location}` : ''}`;
}

export async function tool_rsvp_event(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('rsvp_event', id);
  if (gate) return gate;
  const queryLabel = String(args.query ?? args.title ?? '').trim();
  try {
    const resolved = await resolveUpcomingEvent(sb, args.event_id, queryLabel);
    if (resolved.kind === 'error') return { ok: false, error: resolved.message };
    if (resolved.kind === 'none') {
      return {
        ok: true,
        result: { rsvped: false },
        text: queryLabel
          ? `I couldn't find an upcoming event matching "${queryLabel}". Want me to list the upcoming meetups?`
          : 'Which event would you like to sign up for? Tell me its name.',
      };
    }
    if (resolved.kind === 'many') {
      const lines = resolved.events.map(speakEventLine).join('; ');
      return {
        ok: true,
        result: {
          rsvped: false,
          candidates: resolved.events.map((e) => ({ event_id: e.id, title: e.title, start_time: e.start_time })),
        },
        text: `I found ${resolved.events.length} matching events: ${lines}. Which one do you mean?`,
      };
    }
    const event = resolved.event;

    const { data: existing } = await sb
      .from('global_event_participants')
      .select('id, status')
      .eq('event_id', event.id)
      .eq('user_id', id.user_id)
      .maybeSingle();
    if (existing && (existing as { status?: string }).status === 'attending') {
      return {
        ok: true,
        result: { rsvped: false, already_attending: true, event_id: event.id, title: event.title },
        text: `You're already signed up for ${speakEventLine(event)}.`,
      };
    }

    const count = Number(event.participant_count) || 0;
    if (event.max_participants != null && count >= event.max_participants) {
      return {
        ok: true,
        result: { rsvped: false, full: true, event_id: event.id, title: event.title },
        text: `Unfortunately "${event.title}" is already full (${event.max_participants} participants).`,
      };
    }

    // Same write contract as the frontend's useEventParticipation hook:
    // upsert on (event_id, user_id) with status 'attending'.
    const { error: upErr } = await sb
      .from('global_event_participants')
      .upsert({ event_id: event.id, user_id: id.user_id, status: 'attending' }, { onConflict: 'event_id,user_id' });
    if (upErr) return { ok: false, error: upErr.message };

    // Sync participant_count on the event row (best-effort, like the UI).
    if (!existing) {
      try {
        await sb
          .from('global_community_events')
          .update({ participant_count: count + 1 })
          .eq('id', event.id);
      } catch {
        /* count sync is cosmetic — never fail the RSVP for it */
      }
    }

    return {
      ok: true,
      result: { rsvped: true, event_id: event.id, title: event.title, start_time: event.start_time },
      text: `You're in! I've signed you up for ${speakEventLine(event)}.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'rsvp_event failed' };
  }
}

// ---------------------------------------------------------------------------
// cancel_rsvp (VTID-02774)
// ---------------------------------------------------------------------------

export async function tool_cancel_rsvp(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('cancel_rsvp', id);
  if (gate) return gate;
  const queryLabel = String(args.query ?? args.title ?? '').trim().toLowerCase();
  const eventIdArg = String(args.event_id ?? '').trim();
  try {
    // Start from the user's own attending rows — cancellation only ever
    // targets the caller's RSVPs.
    const { data: parts, error: pErr } = await sb
      .from('global_event_participants')
      .select('event_id')
      .eq('user_id', id.user_id)
      .eq('status', 'attending');
    if (pErr) return { ok: false, error: pErr.message };
    const eventIds = ((parts as Array<{ event_id: string }>) ?? []).map((p) => p.event_id);
    if (eventIds.length === 0) {
      return { ok: true, result: { cancelled: false }, text: "You don't have any event RSVPs to cancel." };
    }

    const { data: events, error: eErr } = await sb
      .from('global_community_events')
      .select(EVENT_COLS)
      .in('id', eventIds)
      .gte('start_time', new Date().toISOString())
      .order('start_time', { ascending: true });
    if (eErr) return { ok: false, error: eErr.message };
    let mine = (events as EventRow[]) ?? [];
    if (UUID_RE.test(eventIdArg)) {
      mine = mine.filter((e) => e.id === eventIdArg);
    } else if (queryLabel) {
      mine = mine.filter((e) => e.title.toLowerCase().includes(queryLabel));
    }

    if (mine.length === 0) {
      return {
        ok: true,
        result: { cancelled: false },
        text: "I couldn't find an upcoming RSVP of yours matching that. You may not be signed up for it.",
      };
    }
    if (mine.length > 1) {
      const lines = mine.slice(0, 5).map(speakEventLine).join('; ');
      return {
        ok: true,
        result: {
          cancelled: false,
          candidates: mine.slice(0, 5).map((e) => ({ event_id: e.id, title: e.title, start_time: e.start_time })),
        },
        text: `You're signed up for ${mine.length} upcoming events: ${lines}. Which RSVP should I cancel?`,
      };
    }

    const event = mine[0];
    if (args.confirm !== true) {
      return {
        ok: true,
        result: { needs_confirmation: true, event_id: event.id, title: event.title },
        text: `Confirm with the user: cancel their RSVP for ${speakEventLine(event)}? When they say yes, call cancel_rsvp again with this event_id and confirm:true.`,
      };
    }

    const { error: delErr } = await sb
      .from('global_event_participants')
      .delete()
      .eq('event_id', event.id)
      .eq('user_id', id.user_id);
    if (delErr) return { ok: false, error: delErr.message };

    try {
      const count = Number(event.participant_count) || 0;
      await sb
        .from('global_community_events')
        .update({ participant_count: Math.max(0, count - 1) })
        .eq('id', event.id);
    } catch {
      /* count sync is cosmetic */
    }

    return {
      ok: true,
      result: { cancelled: true, event_id: event.id, title: event.title },
      text: `Done — I've cancelled your RSVP for "${event.title}".`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'cancel_rsvp failed' };
  }
}

// ---------------------------------------------------------------------------
// list_upcoming_meetups (VTID-02774)
// ---------------------------------------------------------------------------

export async function tool_list_upcoming_meetups(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('list_upcoming_meetups', id);
  if (gate) return gate;
  try {
    const { data, error } = await sb
      .from('global_community_events')
      .select(EVENT_COLS)
      .gte('start_time', new Date().toISOString())
      .order('start_time', { ascending: true })
      .limit(8);
    if (error) return { ok: false, error: error.message };
    const events = (data as EventRow[]) ?? [];
    if (events.length === 0) {
      return {
        ok: true,
        result: { events: [] },
        text: 'There are no upcoming meetups scheduled right now. Check back soon — new events are added regularly!',
      };
    }

    // Optional proximity: the user's home city (same source search_events uses).
    let homeCity = '';
    try {
      const { data: locRow } = await sb
        .from('location_preferences')
        .select('home_city')
        .eq('user_id', id.user_id)
        .maybeSingle();
      homeCity = ((locRow as { home_city?: string | null } | null)?.home_city ?? '').trim();
    } catch {
      /* best-effort — proceed without proximity */
    }

    // Mark which ones the user is already attending.
    const attending = new Set<string>();
    try {
      const { data: parts } = await sb
        .from('global_event_participants')
        .select('event_id')
        .eq('user_id', id.user_id)
        .eq('status', 'attending')
        .in('event_id', events.map((e) => e.id));
      for (const p of (parts as Array<{ event_id: string }>) ?? []) attending.add(p.event_id);
    } catch {
      /* attendance markers are best-effort */
    }

    const isNear = (e: EventRow) =>
      !!homeCity && !!e.location && e.location.toLowerCase().includes(homeCity.toLowerCase());
    const ordered = homeCity ? [...events.filter(isNear), ...events.filter((e) => !isNear(e))] : events;

    const lines = ordered
      .slice(0, 5)
      .map(
        (e) =>
          `${speakEventLine(e)}${isNear(e) ? ' (near you)' : ''}${attending.has(e.id) ? " (you're signed up)" : ''}`,
      )
      .join('; ');
    return {
      ok: true,
      result: {
        events: ordered.map((e) => ({
          event_id: e.id,
          title: e.title,
          start_time: e.start_time,
          location: e.location,
          near_user: isNear(e),
          attending: attending.has(e.id),
        })),
        home_city: homeCity || null,
      },
      text: `Upcoming meetups: ${lines}. Want me to sign you up for one?`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'list_upcoming_meetups failed' };
  }
}

// ---------------------------------------------------------------------------
// join_live_room (VTID-02774)
// ---------------------------------------------------------------------------

interface LiveRoomRow {
  id: string;
  title: string;
  starts_at: string;
  status: string;
}

export async function tool_join_live_room(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('join_live_room', id);
  if (gate) return gate;
  if (!id.tenant_id) {
    // live_rooms is tenant-scoped — same guard tool_search_events applies.
    return {
      ok: true,
      result: { rooms: [] },
      text: 'Live rooms are unavailable for this session (no tenant context).',
    };
  }
  const roomIdArg = String(args.room_id ?? '').trim();
  const query = String(args.query ?? args.title ?? '').trim();
  try {
    let rooms: LiveRoomRow[] = [];
    if (UUID_RE.test(roomIdArg)) {
      const { data, error } = await sb
        .from('live_rooms')
        .select('id, title, starts_at, status')
        .eq('tenant_id', id.tenant_id)
        .eq('id', roomIdArg)
        .in('status', ['scheduled', 'live'])
        .maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (data) rooms = [data as LiveRoomRow];
    } else {
      let q = sb
        .from('live_rooms')
        .select('id, title, starts_at, status')
        .eq('tenant_id', id.tenant_id)
        .in('status', ['scheduled', 'live'])
        .order('starts_at', { ascending: true })
        .limit(5);
      if (query) q = q.ilike('title', `%${query}%`);
      const { data, error } = await q;
      if (error) return { ok: false, error: error.message };
      rooms = (data as LiveRoomRow[]) ?? [];
    }

    if (rooms.length === 0) {
      return {
        ok: true,
        result: { rooms: [] },
        text: query
          ? `I couldn't find a live room matching "${query}" that's live or scheduled right now.`
          : 'There are no live rooms running or scheduled right now.',
      };
    }

    const speakRoom = (r: LiveRoomRow) =>
      `"${r.title}" (${r.status === 'live' ? 'LIVE now' : `starts ${fmtWhen(r.starts_at)}`})`;

    // Dominant pick: single hit, exact title match, or — with no query — the
    // one room that is live right now. Otherwise list and let the LLM ask.
    let top: LiveRoomRow | undefined;
    if (rooms.length === 1) {
      top = rooms[0];
    } else if (query) {
      top = rooms.find((r) => r.title.toLowerCase() === query.toLowerCase());
    } else {
      const liveNow = rooms.filter((r) => r.status === 'live');
      if (liveNow.length === 1) top = liveNow[0];
    }

    if (!top) {
      return {
        ok: true,
        result: {
          rooms: rooms.map((r) => ({ room_id: r.id, title: r.title, status: r.status, starts_at: r.starts_at })),
          decision: 'list_only',
        },
        text: `I found ${rooms.length} rooms: ${rooms.map(speakRoom).join('; ')}. Which one should I open?`,
      };
    }

    const route = `/comm/live-rooms/${encodeURIComponent(top.id)}/view`;
    return {
      ok: true,
      result: {
        room_id: top.id,
        title: top.title,
        status: top.status,
        decision: 'auto_nav',
        directive: navDirective('COMM.LIVE_ROOM_VIEWER', route, top.title, 'join_live_room resolved', VTID_EVENTS),
        redirect: { route },
      },
      text:
        top.status === 'live'
          ? `Taking you into "${top.title}" — it's live right now.`
          : `Opening "${top.title}" — it starts ${fmtWhen(top.starts_at)}.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'join_live_room failed' };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const GROUPS_EVENTS_TOOL_HANDLERS: Record<string, Handler> = {
  list_my_groups: tool_list_my_groups,
  create_group: tool_create_group,
  join_group: tool_join_group,
  invite_to_group: tool_invite_to_group,
  accept_invitation: tool_accept_invitation,
  decline_invitation: tool_decline_invitation,
  rsvp_event: tool_rsvp_event,
  cancel_rsvp: tool_cancel_rsvp,
  list_upcoming_meetups: tool_list_upcoming_meetups,
  join_live_room: tool_join_live_room,
};

export const GROUPS_EVENTS_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'list_my_groups',
    description: [
      "List the community groups the user belongs to, with member counts.",
      'CALL WHEN the user asks: "what groups am I in?", "show my groups",',
      '"in welchen Gruppen bin ich?", "zeig mir meine Gruppen".',
      'After the tool runs, read the group names and member counts aloud.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_group',
    description: [
      'Create a new community group. Requires a name; privacy is public or',
      'private (default public). ALWAYS call once WITHOUT confirm first —',
      'the tool returns a confirmation question; after the user says yes,',
      'call again with confirm:true.',
      'CALL WHEN the user says: "create a group called ...", "start a new',
      'group", "erstelle eine Gruppe ...", "gründe eine neue Gruppe".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The group name.' },
        description: { type: 'string', description: 'Optional short group description.' },
        privacy: { type: 'string', description: "Either 'public' or 'private'. Public if omitted." },
        confirm: { type: 'boolean', description: 'Pass true ONLY after the user confirmed the creation.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'join_group',
    description: [
      'Join a community group by name or group_id. Resolves fuzzy names and',
      'lists candidates when several match. Private groups cannot be self-joined.',
      'CALL WHEN the user says: "join the sleep group", "I want to join ...",',
      '"tritt der Gruppe ... bei", "ich möchte der Gruppe beitreten".',
      'After joining, tell the user they are in and the app is opening the group.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Spoken group name (fuzzy matched).' },
        group_id: { type: 'string', description: 'Exact group UUID when already known from a previous tool result.' },
      },
      required: [],
    },
  },
  {
    name: 'invite_to_group',
    description: [
      'Invite another community member to a group. Resolves the member by',
      'spoken name and the group by name; the member gets a notification.',
      'CALL WHEN the user says: "invite Anna to my walking group",',
      '"lade Anna in die Gruppe ... ein".',
      'If the tool lists several member or group candidates, ask which one.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Spoken group name (fuzzy matched).' },
        group_id: { type: 'string', description: 'Exact group UUID when known.' },
        member_name: { type: 'string', description: 'Spoken name of the member to invite.' },
        member_user_id: { type: 'string', description: 'Exact user UUID when known from a previous tool result.' },
        message: { type: 'string', description: 'Optional personal message to include.' },
      },
      required: [],
    },
  },
  {
    name: 'accept_invitation',
    description: [
      'Accept a pending group invitation (joins the group). With no',
      'invitation_id it lists the pending invitations, or acts when only one.',
      'CALL WHEN the user says: "accept the invitation", "yes, join that group",',
      '"nimm die Einladung an", "Einladung annehmen".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        invitation_id: { type: 'string', description: 'The invitation UUID from a previous tool result, if known.' },
        group: { type: 'string', description: 'Spoken group name to pick among several pending invitations.' },
      },
      required: [],
    },
  },
  {
    name: 'decline_invitation',
    description: [
      'Decline a pending group invitation. ALWAYS call once WITHOUT confirm',
      'first — the tool returns a confirmation question; after the user says',
      'yes, call again with the invitation_id and confirm:true.',
      'CALL WHEN the user says: "decline the invitation", "no thanks, decline',
      'it", "lehne die Einladung ab", "Einladung ablehnen".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        invitation_id: { type: 'string', description: 'The invitation UUID from a previous tool result, if known.' },
        group: { type: 'string', description: 'Spoken group name to pick among several pending invitations.' },
        confirm: { type: 'boolean', description: 'Pass true ONLY after the user confirmed declining.' },
      },
      required: [],
    },
  },
  {
    name: 'rsvp_event',
    description: [
      'RSVP / sign the user up for a community event or meetup, by event_id',
      'or fuzzy title. Checks capacity and existing signup first.',
      'CALL WHEN the user says: "sign me up for ...", "RSVP to the yoga',
      'meetup", "melde mich für ... an", "ich will beim Event ... dabei sein".',
      'If several events match, read the candidates and ask which one.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Spoken event title (fuzzy matched against upcoming events).' },
        event_id: { type: 'string', description: 'Exact event UUID when known from a previous tool result.' },
      },
      required: [],
    },
  },
  {
    name: 'cancel_rsvp',
    description: [
      "Cancel the user's RSVP for an upcoming event. ALWAYS call once",
      'WITHOUT confirm first — the tool returns a confirmation question;',
      'after the user says yes, call again with the event_id and confirm:true.',
      'CALL WHEN the user says: "cancel my RSVP", "I can\'t make it to ...",',
      '"melde mich vom Event ... ab", "storniere meine Anmeldung".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Spoken event title (matched against the user\'s RSVPs).' },
        event_id: { type: 'string', description: 'Exact event UUID when known.' },
        confirm: { type: 'boolean', description: 'Pass true ONLY after the user confirmed the cancellation.' },
      },
      required: [],
    },
  },
  {
    name: 'list_upcoming_meetups',
    description: [
      'List upcoming community meetups/events the user could attend, soonest',
      'first; events in the user\'s home city are flagged "near you" and',
      'events they already RSVP\'d are marked.',
      'CALL WHEN the user asks: "what meetups are coming up?", "any events',
      'this week?", "welche Meetups stehen an?", "gibt es bald Events?".',
      'Read the titles with dates aloud, then offer to sign them up.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'join_live_room',
    description: [
      'Join/open a community live room by name or room_id. Returns a',
      'navigation directive that opens the room screen — the app navigates',
      'automatically; do not describe the navigation mechanics.',
      'CALL WHEN the user says: "join the live room", "take me into the ...',
      'room", "bring mich in den Live-Raum", "öffne den Live-Raum ...".',
      'If several rooms match, read the candidates and ask which one.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Spoken room title (fuzzy matched against live and scheduled rooms).' },
        room_id: { type: 'string', description: 'Exact live room UUID when known.' },
      },
      required: [],
    },
  },
];
