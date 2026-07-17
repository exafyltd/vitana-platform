/**
 * Messaging depth (A8) voice tools — group chat, reactions, and call invites.
 *
 * Tables used (all verified against real migrations, no invented schema):
 *
 *  - chat_groups / chat_group_members (supabase/migrations/
 *    20260525000000_VTID_03089_chat_groups.sql) — many-to-many group chat on
 *    top of the 1-to-1 chat_messages model. chat_group_members has no
 *    dedicated HTTP add/leave route (routes/chat-groups.ts only exposes
 *    list/get/messages/send/read/edit/delete) — this file writes to it
 *    directly, exactly the same pattern create_group / join_group in
 *    groups-events-tools.ts already use for the sibling
 *    global_community_group_members table.
 *
 *  - chat_messages.group_id (same migration) — a chat_messages row is either
 *    a DM (receiver_id set, group_id null) or a group message (group_id set,
 *    receiver_id null); enforced by chat_messages_target_xor. Group sends
 *    here mirror routes/chat-groups.ts POST /:id/send (membership required,
 *    message_type default 'text', metadata jsonb, best-effort push fanout).
 *
 *  - message_reactions (vitana-v1 migration 20250918121049 — polymorphic on
 *    chat_messages.id / global_messages.id / messages.id; message_id UUID,
 *    user_id UUID, emoji TEXT CHECK IN ('👍','❤️','😂','😮','🙏','🎉'),
 *    PRIMARY KEY (message_id, user_id, emoji)). notify_on_reaction() already
 *    fires a push on insert (supabase/migrations/
 *    20260710120000_fix_reaction_notification_deeplink.sql), so this file
 *    only needs to insert/delete the row.
 *
 *  - calendar_events (services/calendar-service.ts; user_id-scoped) — reused
 *    read-only to resolve which event to share; the message itself goes
 *    through the same chat_messages insert tool_share_link in
 *    orb-tools-shared.ts uses for link shares (custom message_type value,
 *    structured metadata), since resolveAndValidateRecipient /
 *    emitChatSendFailure in that file are module-private and not exported.
 *
 * NOT backed by any real table/route (verified, not invented):
 *
 *  - reply_to_message: chat_messages (and global_messages / messages) have
 *    no reply-to / parent-message / thread column anywhere in the schema
 *    (grepped supabase/migrations for reply_to|parent_message|in_reply_to|
 *    quoted_message — zero hits). Stubbed as unavailable rather than
 *    inventing a fake thread.
 *
 *  - start_voice_call / start_video_call: vitana-v1's useWebRTC.ts /
 *    useCallState.ts / CallContext.tsx show calling is 100% client-side —
 *    raw WebRTC peer connections signaled over ad-hoc Supabase Realtime
 *    broadcast channels (`user:<id>:calls`, `room:<roomId>`), with no
 *    server-side call/session table or gateway route anywhere. The gateway
 *    cannot place or ring a call (no media capability, no persisted call
 *    state to join). Per the wave-1 brief, these two tools instead send a
 *    real chat_messages "call invite" row + push notification asking the
 *    other person to open the app — they do not connect a call.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { notifyUserAsync } from '../notification-service';
import { checkVoiceSendQuota } from '../voice-message-guard';

type Handler = (args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient) => Promise<OrbToolResult>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_REACTION_EMOJIS = new Set(['👍', '❤️', '😂', '😮', '🙏', '🎉']);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** ok:false when there is no authenticated user — every tool here touches user data. */
function authGate(tool: string, id: OrbToolIdentity): OrbToolResult | null {
  if (!id.user_id) {
    return { ok: false, error: `${tool} requires an authenticated user.` };
  }
  return null;
}

/** First non-empty string among the given arg keys. */
function argString(args: OrbToolArgs, ...keys: string[]): string {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
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

interface ResolvedMember {
  user_id: string;
  display_name: string | null;
  vitana_id: string | null;
}

function memberDisplay(m: ResolvedMember): string {
  return m.display_name || m.vitana_id || 'that member';
}

/**
 * Resolve a spoken name / Vitana ID / UUID to a single confident member —
 * same canonical RPC + thresholds as tool_resolve_recipient /
 * tool_send_chat_message in orb-tools-shared.ts and resolveMember in
 * chat-privacy-tools.ts / groups-events-tools.ts.
 */
async function resolveMember(
  raw: string,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<{ ok: true; member: ResolvedMember } | { ok: false; error: string }> {
  const token = raw.trim();
  if (!token) {
    return { ok: false, error: 'Who do you mean? Please say their name or Vitana ID.' };
  }

  if (UUID_RE.test(token)) {
    const { data, error } = await sb
      .from('app_users')
      .select('user_id, display_name, vitana_id')
      .eq('user_id', token)
      .maybeSingle();
    if (error) {
      return { ok: false, error: 'I had a problem looking that member up — want me to try again?' };
    }
    if (!data) {
      return { ok: false, error: "I couldn't find that member — they may have left the community." };
    }
    return { ok: true, member: data as ResolvedMember };
  }

  const { data, error } = await sb.rpc('resolve_recipient_candidates', {
    p_actor: id.user_id,
    p_token: token,
    p_limit: 5,
    p_global: true,
  });
  if (error) {
    return { ok: false, error: `I had a problem looking up ${token} — want me to try again?` };
  }
  const candidates = (data || []) as Array<{
    user_id: string;
    vitana_id: string | null;
    display_name: string | null;
    score: number;
  }>;
  if (candidates.length === 0) {
    return { ok: false, error: `I couldn't find anyone named "${token}" in the community.` };
  }
  const topScore = Number(candidates[0].score);
  const secondScore = candidates[1] ? Number(candidates[1].score) : 0;
  const ambiguous = topScore < 0.85 || secondScore / Math.max(topScore, 0.0001) > 0.85;
  if (ambiguous) {
    const names = candidates
      .slice(0, 3)
      .map((c) => c.display_name || c.vitana_id || c.user_id)
      .join(', ');
    return {
      ok: false,
      error: `I found several possible matches for "${token}": ${names}. Which one did you mean?`,
    };
  }
  const top = candidates[0];
  return {
    ok: true,
    member: {
      user_id: top.user_id,
      display_name: top.display_name ?? null,
      vitana_id: top.vitana_id ?? null,
    },
  };
}

/** Best-effort sender display name for fanout notification bodies. */
async function senderDisplayName(sb: SupabaseClient, userId: string): Promise<string> {
  try {
    const [{ data: profile }, { data: appUser }] = await Promise.all([
      sb.from('profiles').select('display_name, full_name').eq('user_id', userId).maybeSingle(),
      sb.from('app_users').select('display_name, email').eq('user_id', userId).maybeSingle(),
    ]);
    const p = profile as { display_name?: string | null; full_name?: string | null } | null;
    const au = appUser as { display_name?: string | null; email?: string | null } | null;
    return (
      p?.display_name ||
      p?.full_name ||
      au?.display_name ||
      (au?.email ? au.email.split('@')[0] : null) ||
      'Someone'
    );
  } catch {
    return 'Someone';
  }
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

// ---------------------------------------------------------------------------
// Chat-group resolution (chat_groups / chat_group_members)
// ---------------------------------------------------------------------------

interface ChatGroupRow {
  id: string;
  name: string;
  description: string | null;
  is_system: boolean | null;
  tenant_id: string;
}

type ChatGroupResolution =
  | { kind: 'one'; group: ChatGroupRow }
  | { kind: 'many'; groups: ChatGroupRow[] }
  | { kind: 'none' }
  | { kind: 'error'; message: string };

/**
 * Resolve a group chat the CALLER already belongs to, by id or fuzzy name.
 * Scoping to the caller's own chat_group_members rows doubles as the
 * membership check every group-chat tool below needs (you cannot send to,
 * add members to, or leave a group you are not in) — same security shape as
 * invite_to_group's caller-membership check in groups-events-tools.ts.
 */
async function resolveMyChatGroup(
  sb: SupabaseClient,
  userId: string,
  rawGroupId: unknown,
  rawQuery: unknown,
): Promise<ChatGroupResolution> {
  const groupIdArg = String(rawGroupId ?? '').trim();
  const query = String(rawQuery ?? '').trim();

  const { data: memberships, error: mErr } = await sb
    .from('chat_group_members')
    .select('group_id')
    .eq('user_id', userId);
  if (mErr) return { kind: 'error', message: mErr.message };
  const groupIds = ((memberships as Array<{ group_id: string }>) ?? []).map((m) => m.group_id);
  if (groupIds.length === 0) return { kind: 'none' };

  const { data: groups, error: gErr } = await sb
    .from('chat_groups')
    .select('id, name, description, is_system, tenant_id')
    .in('id', groupIds);
  if (gErr) return { kind: 'error', message: gErr.message };
  const myGroups = (groups as ChatGroupRow[]) ?? [];
  if (myGroups.length === 0) return { kind: 'none' };

  if (UUID_RE.test(groupIdArg)) {
    const hit = myGroups.find((g) => g.id === groupIdArg);
    return hit ? { kind: 'one', group: hit } : { kind: 'none' };
  }

  if (query) {
    const matches = myGroups.filter((g) => g.name.toLowerCase().includes(query.toLowerCase()));
    if (matches.length === 0) return { kind: 'none' };
    if (matches.length === 1) return { kind: 'one', group: matches[0] };
    const exact = matches.find((g) => g.name.toLowerCase() === query.toLowerCase());
    if (exact) return { kind: 'one', group: exact };
    return { kind: 'many', groups: matches };
  }

  // No id/query given — auto-resolve only when the caller is in exactly one
  // group chat; otherwise the model must ask which one.
  if (myGroups.length === 1) return { kind: 'one', group: myGroups[0] };
  return { kind: 'many', groups: myGroups };
}

function groupNotFoundText(query: string): string {
  return query
    ? `I couldn't find a group chat of yours matching "${query}". Which group chat did you mean?`
    : "I couldn't find that group chat, or you're not a member of it.";
}

function groupAmbiguousResult(groups: ChatGroupRow[]) {
  const names = groups.map((g) => g.name).join(', ');
  return {
    ok: true as const,
    result: { resolved: false, candidates: groups.map((g) => ({ group_id: g.id, name: g.name })) },
    text: `You're in ${groups.length} group chats matching that: ${names}. Which one did you mean?`,
  };
}

function groupNoneResult(query: string) {
  return { ok: true as const, result: { resolved: false }, text: groupNotFoundText(query) };
}

// ---------------------------------------------------------------------------
// 1. send_group_chat_message
// ---------------------------------------------------------------------------

export const tool_send_group_chat_message: Handler = async (args, id, sb) => {
  const gate = authGate('send_group_chat_message', id);
  if (gate) return gate;
  try {
    const body = argString(args, 'message', 'body', 'text');
    if (!body) {
      return { ok: false, error: "I didn't catch the message — what would you like me to say?" };
    }
    const queryLabel = argString(args, 'group', 'group_name', 'query');
    const resolved = await resolveMyChatGroup(sb, id.user_id, args.group_id, queryLabel);
    if (resolved.kind === 'error') return { ok: false, error: resolved.message };
    if (resolved.kind === 'none') return groupNoneResult(queryLabel);
    if (resolved.kind === 'many') return groupAmbiguousResult(resolved.groups);
    const group = resolved.group;

    if (args.confirmed !== true) {
      return {
        ok: true,
        result: {
          stage: 'awaiting_confirmation',
          group_id: group.id,
          group_name: group.name,
          message_preview: body,
        },
        text: `Ready to send to "${group.name}": "${body}". Read this back and only call send_group_chat_message again with confirmed=true after explicit confirmation.`,
      };
    }

    const quota = await checkVoiceSendQuota({
      // No single recipient exists for a group send; the group id stands in
      // so the same per-session voice-send cap (VTID-01967) still applies to
      // group chats, not just DMs.
      session_id: `${id.user_id}:send_group_chat_message`,
      actor_id: id.user_id,
      vitana_id: id.vitana_id ?? null,
      recipient_user_id: group.id,
      recipient_vitana_id: null,
      kind: 'message',
      body_length: body.length,
    });
    if (!quota.allowed) {
      return {
        ok: true,
        result: { rate_limited: true, reason: quota.reason },
        text: `Couldn't send (${quota.reason ?? 'rate-limited'}). Try again in a bit.`,
      };
    }

    const { data: inserted, error: insErr } = await sb
      .from('chat_messages')
      .insert({
        tenant_id: group.tenant_id,
        sender_id: id.user_id,
        receiver_id: null,
        group_id: group.id,
        content: body,
        message_type: 'text',
        metadata: { source: 'voice', kind: 'group_message' },
      })
      .select('id')
      .single();
    if (insErr) {
      return { ok: false, error: "I couldn't send that just now — want me to try again?" };
    }
    const messageId = (inserted as { id: string }).id;

    // Best-effort push fanout — same shape as routes/chat-groups.ts's
    // fanoutGroupNotifications, minus @vitana-mention handling (that is a
    // whole conversation-brain flow out of scope for this voice tool).
    try {
      const { data: members } = await sb
        .from('chat_group_members')
        .select('user_id')
        .eq('group_id', group.id);
      const senderName = await senderDisplayName(sb, id.user_id);
      const preview = body.length > 100 ? `${body.slice(0, 97)}...` : body;
      for (const m of (members as Array<{ user_id: string }>) ?? []) {
        if (m.user_id === id.user_id) continue;
        notifyUserAsync(
          m.user_id,
          group.tenant_id,
          'new_chat_message',
          {
            title: group.name,
            body: `${senderName}: ${preview}`,
            data: {
              type: 'new_group_message',
              group_id: group.id,
              sender_id: id.user_id,
              message_id: messageId,
              url: `/inbox/g/${group.id}`,
            },
          },
          sb,
        );
      }
    } catch {
      /* fanout is best-effort; never fail the send because of it */
    }

    return {
      ok: true,
      result: { sent: true, group_id: group.id, message_id: messageId },
      text: `Sent to "${group.name}".`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'send_group_chat_message error';
    return { ok: false, error: `I hit a snag sending that (${msg}).` };
  }
};

// ---------------------------------------------------------------------------
// 2. reply_to_message — stub (no backing column)
// ---------------------------------------------------------------------------

/**
 * chat_messages (and global_messages / messages) have no reply-to / parent /
 * thread column anywhere in the schema — grepped every migration for
 * reply_to|parent_message|in_reply_to|quoted_message with zero hits.
 * There is nowhere to persist "this message replies to that one", so per the
 * wave-1 hard rule this is an honest stub rather than a fabricated thread.
 */
export const tool_reply_to_message: Handler = async (_args, _id, _sb) => {
  return {
    ok: false,
    error:
      'reply_to_message is not available yet — no backing endpoint. Vitana chat has no reply/quote-thread ' +
      'column, so a reply cannot be linked to the original message. Offer to send_chat_message or ' +
      'send_group_chat_message with the quoted context typed into the new message instead, and say plainly ' +
      'that threaded replies are not supported yet.',
  };
};

// ---------------------------------------------------------------------------
// 3. react_to_message
// ---------------------------------------------------------------------------

export const tool_react_to_message: Handler = async (args, id, sb) => {
  const gate = authGate('react_to_message', id);
  if (gate) return gate;
  try {
    const messageId = argString(args, 'message_id', 'message');
    if (!UUID_RE.test(messageId)) {
      return { ok: false, error: 'react_to_message needs a message_id (UUID) from a previous tool result.' };
    }
    const emoji = argString(args, 'emoji', 'reaction');
    if (!emoji || !ALLOWED_REACTION_EMOJIS.has(emoji)) {
      return {
        ok: false,
        error: `Reactions must be one of 👍 ❤️ 😂 😮 🙏 🎉 — "${emoji || 'none given'}" isn't supported.`,
      };
    }

    // Access check: the message must be a DM the caller sent/received, or a
    // group message in a group the caller belongs to — same predicate the
    // message_reactions RLS SELECT policy and get_message_reactions_text RPC
    // use (supabase/migrations/20260522000000_vtid_03089_chat_group_reactions_rls.sql).
    const { data: msgRow, error: msgErr } = await sb
      .from('chat_messages')
      .select('id, sender_id, receiver_id, group_id')
      .eq('id', messageId)
      .maybeSingle();
    if (msgErr) return { ok: false, error: "I had a problem finding that message — want me to try again?" };
    if (!msgRow) return { ok: false, error: "I couldn't find that message." };
    const msg = msgRow as { sender_id: string; receiver_id: string | null; group_id: string | null };

    let allowed = msg.sender_id === id.user_id || msg.receiver_id === id.user_id;
    if (!allowed && msg.group_id) {
      const { data: membership } = await sb
        .from('chat_group_members')
        .select('user_id')
        .eq('group_id', msg.group_id)
        .eq('user_id', id.user_id)
        .maybeSingle();
      allowed = Boolean(membership);
    }
    if (!allowed) {
      return { ok: false, error: "You don't have access to that message." };
    }

    if (args.remove === true) {
      const { error: delErr } = await sb
        .from('message_reactions')
        .delete()
        .eq('message_id', messageId)
        .eq('user_id', id.user_id)
        .eq('emoji', emoji);
      if (delErr) return { ok: false, error: "I couldn't remove that reaction just now — want me to try again?" };
      return { ok: true, result: { removed: true, message_id: messageId, emoji }, text: `Removed your ${emoji} reaction.` };
    }

    const { error: insErr } = await sb
      .from('message_reactions')
      .insert({ message_id: messageId, user_id: id.user_id, emoji });
    if (insErr) {
      if ((insErr as { code?: string }).code === '23505') {
        return {
          ok: true,
          result: { already_reacted: true, message_id: messageId, emoji },
          text: `You already reacted ${emoji} to that message.`,
        };
      }
      return { ok: false, error: "I couldn't add that reaction just now — want me to try again?" };
    }
    return {
      ok: true,
      result: { reacted: true, message_id: messageId, emoji },
      text: `Reacted ${emoji} to that message.`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'react_to_message error';
    return { ok: false, error: `I hit a snag with that reaction (${msg}).` };
  }
};

// ---------------------------------------------------------------------------
// 4. create_group_chat
// ---------------------------------------------------------------------------

function parseMemberList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v ?? '').trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw
      .split(/,| and | und /i)
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

export const tool_create_group_chat: Handler = async (args, id, sb) => {
  const gate = authGate('create_group_chat', id);
  if (gate) return gate;
  const name = argString(args, 'name', 'group_name');
  const description = argString(args, 'description');
  if (!name) {
    return { ok: false, error: 'create_group_chat requires a name for the group. What should it be called?' };
  }
  const memberNames = parseMemberList(args.members ?? args.member_names);
  if (args.confirm !== true) {
    return {
      ok: true,
      result: {
        needs_confirmation: true,
        name,
        description: description || null,
        members: memberNames,
      },
      text:
        `Confirm with the user: create a group chat called "${name}"` +
        `${memberNames.length ? ` with ${memberNames.join(', ')}` : ''}? ` +
        'When they say yes, call create_group_chat again with confirm:true.',
    };
  }
  try {
    const tenantId = await resolveTenantId(id, sb);
    if (!tenantId) {
      return {
        ok: false,
        error: "I can't create that right now — I'm missing some account context. Try once more in a moment.",
      };
    }
    const { data: group, error: insErr } = await sb
      .from('chat_groups')
      .insert({
        tenant_id: tenantId,
        name,
        description: description || null,
        created_by: id.user_id,
        is_system: false,
        metadata: { source: 'voice' },
      })
      .select('id, name')
      .single();
    if (insErr || !group) {
      return { ok: false, error: insErr?.message ?? 'group chat creation failed' };
    }
    const g = group as { id: string; name: string };

    const { error: memErr } = await sb
      .from('chat_group_members')
      .insert({ group_id: g.id, user_id: id.user_id, tenant_id: tenantId, role: 'admin' });
    if (memErr && (memErr as { code?: string }).code !== '23505') {
      return { ok: false, error: memErr.message };
    }

    const added: string[] = [];
    const failed: string[] = [];
    for (const nameArg of memberNames) {
      const resolved = await resolveMember(nameArg, id, sb);
      if (!resolved.ok) {
        failed.push(nameArg);
        continue;
      }
      const target = resolved.member;
      if (target.user_id === id.user_id) continue;
      const { error: addErr } = await sb
        .from('chat_group_members')
        .insert({ group_id: g.id, user_id: target.user_id, tenant_id: tenantId, role: 'member' });
      if (addErr && (addErr as { code?: string }).code !== '23505') {
        failed.push(nameArg);
        continue;
      }
      added.push(memberDisplay(target));
    }

    const parts = [`Created the group chat "${g.name}".`];
    if (added.length) parts.push(`Added: ${added.join(', ')}.`);
    if (failed.length) parts.push(`Couldn't find/add: ${failed.join(', ')}.`);

    return {
      ok: true,
      result: { group_id: g.id, name: g.name, added_members: added, failed_members: failed },
      text: parts.join(' '),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'create_group_chat error';
    return { ok: false, error: `I hit a snag creating that group chat (${msg}).` };
  }
};

// ---------------------------------------------------------------------------
// 5. add_group_chat_member
// ---------------------------------------------------------------------------

export const tool_add_group_chat_member: Handler = async (args, id, sb) => {
  const gate = authGate('add_group_chat_member', id);
  if (gate) return gate;
  try {
    const queryLabel = argString(args, 'group', 'group_name', 'query');
    const resolved = await resolveMyChatGroup(sb, id.user_id, args.group_id, queryLabel);
    if (resolved.kind === 'error') return { ok: false, error: resolved.message };
    if (resolved.kind === 'none') return groupNoneResult(queryLabel);
    if (resolved.kind === 'many') return groupAmbiguousResult(resolved.groups);
    const group = resolved.group;

    const memberArg = argString(args, 'member', 'member_name', 'name');
    const memberIdArg = argString(args, 'member_user_id');
    if (!memberArg && !memberIdArg) {
      return { ok: false, error: 'Who would you like to add to the group?' };
    }
    const resolvedMember = await resolveMember(memberIdArg || memberArg, id, sb);
    if (!resolvedMember.ok) return resolvedMember;
    const target = resolvedMember.member;
    if (target.user_id === id.user_id) {
      return { ok: false, error: "You're already in this group." };
    }

    const { error: insErr } = await sb
      .from('chat_group_members')
      .insert({ group_id: group.id, user_id: target.user_id, tenant_id: group.tenant_id, role: 'member' });
    const name = memberDisplay(target);
    if (insErr) {
      if ((insErr as { code?: string }).code === '23505') {
        return {
          ok: true,
          result: { added: false, already_member: true, group_id: group.id },
          text: `${name} is already in "${group.name}".`,
        };
      }
      return { ok: false, error: `I couldn't add ${name} just now — want me to try again?` };
    }
    return {
      ok: true,
      result: { added: true, group_id: group.id, member_user_id: target.user_id },
      text: `Added ${name} to "${group.name}".`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'add_group_chat_member error';
    return { ok: false, error: `I hit a snag adding that member (${msg}).` };
  }
};

// ---------------------------------------------------------------------------
// 6. leave_group_chat
// ---------------------------------------------------------------------------

export const tool_leave_group_chat: Handler = async (args, id, sb) => {
  const gate = authGate('leave_group_chat', id);
  if (gate) return gate;
  try {
    const queryLabel = argString(args, 'group', 'group_name', 'query');
    const resolved = await resolveMyChatGroup(sb, id.user_id, args.group_id, queryLabel);
    if (resolved.kind === 'error') return { ok: false, error: resolved.message };
    if (resolved.kind === 'none') return groupNoneResult(queryLabel);
    if (resolved.kind === 'many') return groupAmbiguousResult(resolved.groups);
    const group = resolved.group;

    if (args.confirm !== true) {
      return {
        ok: true,
        result: { needs_confirmation: true, group_id: group.id, group_name: group.name },
        text: `Confirm with the user: leave the group chat "${group.name}"? When they say yes, call leave_group_chat again with this group_id and confirm:true.`,
      };
    }

    const { error: delErr } = await sb
      .from('chat_group_members')
      .delete()
      .eq('group_id', group.id)
      .eq('user_id', id.user_id);
    if (delErr) return { ok: false, error: `I couldn't leave "${group.name}" just now — want me to try again?` };

    return {
      ok: true,
      result: { left: true, group_id: group.id, group_name: group.name },
      text: `You've left "${group.name}".`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'leave_group_chat error';
    return { ok: false, error: `I hit a snag leaving that group (${msg}).` };
  }
};

// ---------------------------------------------------------------------------
// 7. send_calendar_invite_in_chat
// ---------------------------------------------------------------------------

interface CalendarEventRow {
  id: string;
  title: string;
  start_time: string;
  end_time: string | null;
  location: string | null;
}

type CalendarEventResolution =
  | { kind: 'one'; event: CalendarEventRow }
  | { kind: 'many'; events: CalendarEventRow[] }
  | { kind: 'none' }
  | { kind: 'error'; message: string };

/** Resolve one of the CALLER's own (non-cancelled) calendar_events rows. */
async function resolveMyCalendarEvent(
  sb: SupabaseClient,
  userId: string,
  rawEventId: unknown,
  rawQuery: unknown,
): Promise<CalendarEventResolution> {
  const eventIdArg = String(rawEventId ?? '').trim();
  const query = String(rawQuery ?? '').trim();
  const cols = 'id, title, start_time, end_time, location';

  if (UUID_RE.test(eventIdArg)) {
    const { data, error } = await sb
      .from('calendar_events')
      .select(cols)
      .eq('id', eventIdArg)
      .eq('user_id', userId)
      .neq('status', 'cancelled')
      .maybeSingle();
    if (error) return { kind: 'error', message: error.message };
    if (!data) return { kind: 'none' };
    return { kind: 'one', event: data as CalendarEventRow };
  }

  if (!query) return { kind: 'none' };
  const { data, error } = await sb
    .from('calendar_events')
    .select(cols)
    .eq('user_id', userId)
    .neq('status', 'cancelled')
    .gte('start_time', new Date().toISOString())
    .ilike('title', `%${query}%`)
    .order('start_time', { ascending: true })
    .limit(5);
  if (error) return { kind: 'error', message: error.message };
  const events = (data as CalendarEventRow[]) ?? [];
  if (events.length === 0) return { kind: 'none' };
  if (events.length === 1) return { kind: 'one', event: events[0] };
  const exact = events.find((e) => e.title.toLowerCase() === query.toLowerCase());
  if (exact) return { kind: 'one', event: exact };
  return { kind: 'many', events };
}

function speakEvent(e: CalendarEventRow): string {
  return `"${e.title}" on ${fmtWhen(e.start_time)}${e.location ? ` at ${e.location}` : ''}`;
}

export const tool_send_calendar_invite_in_chat: Handler = async (args, id, sb) => {
  const gate = authGate('send_calendar_invite_in_chat', id);
  if (gate) return gate;
  try {
    const memberArg = argString(args, 'member', 'member_name', 'name');
    const memberIdArg = argString(args, 'member_user_id', 'recipient_user_id');
    if (!memberArg && !memberIdArg) {
      return { ok: false, error: 'Who would you like to send the calendar invite to?' };
    }
    const queryLabel = argString(args, 'event', 'query', 'title');
    const resolvedEvent = await resolveMyCalendarEvent(sb, id.user_id, args.event_id, queryLabel);
    if (resolvedEvent.kind === 'error') return { ok: false, error: resolvedEvent.message };
    if (resolvedEvent.kind === 'none') {
      return {
        ok: true,
        result: { sent: false },
        text: queryLabel
          ? `I couldn't find an event of yours matching "${queryLabel}". Which event did you mean?`
          : 'Which event would you like to share? Tell me its title.',
      };
    }
    if (resolvedEvent.kind === 'many') {
      const lines = resolvedEvent.events.map(speakEvent).join('; ');
      return {
        ok: true,
        result: {
          sent: false,
          candidates: resolvedEvent.events.map((e) => ({ event_id: e.id, title: e.title, start_time: e.start_time })),
        },
        text: `I found ${resolvedEvent.events.length} matching events: ${lines}. Which one do you mean?`,
      };
    }
    const event = resolvedEvent.event;

    const resolvedMember = await resolveMember(memberIdArg || memberArg, id, sb);
    if (!resolvedMember.ok) return resolvedMember;
    const target = resolvedMember.member;
    if (target.user_id === id.user_id) {
      return { ok: false, error: "You can't send a calendar invite to yourself." };
    }
    const name = memberDisplay(target);

    if (args.confirmed !== true) {
      return {
        ok: true,
        result: {
          stage: 'awaiting_confirmation',
          recipient_user_id: target.user_id,
          recipient_label: name,
          event_id: event.id,
        },
        text: `Ready to send ${name} the invite for ${speakEvent(event)}. Read this back and only call send_calendar_invite_in_chat again with confirmed=true after explicit confirmation.`,
      };
    }

    const tenantId = await resolveTenantId(id, sb);
    if (!tenantId) {
      return {
        ok: false,
        error: "I can't send right now — I'm missing some account context. Try once more in a moment.",
      };
    }

    const quota = await checkVoiceSendQuota({
      session_id: `${id.user_id}:send_calendar_invite_in_chat`,
      actor_id: id.user_id,
      vitana_id: id.vitana_id ?? null,
      recipient_user_id: target.user_id,
      recipient_vitana_id: target.vitana_id,
      kind: 'message',
    });
    if (!quota.allowed) {
      return {
        ok: true,
        result: { rate_limited: true, reason: quota.reason },
        text: `Couldn't send (${quota.reason ?? 'rate-limited'}). Try again in a bit.`,
      };
    }

    const content = `📅 ${event.title} — ${fmtWhen(event.start_time)}${event.location ? ` at ${event.location}` : ''}`;
    const { error: insErr } = await sb.from('chat_messages').insert({
      tenant_id: tenantId,
      sender_id: id.user_id,
      receiver_id: target.user_id,
      content,
      // Custom message_type value — same convention tool_share_link in
      // orb-tools-shared.ts uses ('link_share'); message_type has no DB
      // CHECK constraint, so a descriptive kind is safe and matches
      // established precedent rather than inventing a new column.
      message_type: 'calendar_invite',
      metadata: {
        source: 'voice',
        kind: 'calendar_invite',
        event_id: event.id,
        title: event.title,
        start_time: event.start_time,
        end_time: event.end_time,
        location: event.location,
      },
    });
    if (insErr) {
      return { ok: false, error: "I couldn't send that invite just now — want me to try again?" };
    }

    try {
      if (!/^00000000-0000-0000-0000-000000000001$/i.test(target.user_id)) {
        const senderName = await senderDisplayName(sb, id.user_id);
        notifyUserAsync(
          target.user_id,
          tenantId,
          'new_chat_message',
          {
            title: senderName,
            body: content,
            data: { type: 'new_chat_message', sender_id: id.user_id, url: `/inbox?peer=${id.user_id}` },
          },
          sb,
        );
      }
    } catch {
      /* push is best-effort */
    }

    return {
      ok: true,
      result: { sent: true, recipient_user_id: target.user_id, event_id: event.id },
      text: `Sent ${name} the invite for ${speakEvent(event)}.`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'send_calendar_invite_in_chat error';
    return { ok: false, error: `I hit a snag sending that invite (${msg}).` };
  }
};

// ---------------------------------------------------------------------------
// 8 & 9. start_voice_call / start_video_call — call INVITE only, not a real
// connection (see header comment: calling is client-only WebRTC with no
// server-side call table or route to drive from the gateway).
// ---------------------------------------------------------------------------

async function sendCallInvite(
  isVideo: boolean,
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const tool = isVideo ? 'start_video_call' : 'start_voice_call';
  const gate = authGate(tool, id);
  if (gate) return gate;
  try {
    const memberArg = argString(args, 'member', 'member_name', 'name');
    const memberIdArg = argString(args, 'member_user_id', 'recipient_user_id');
    if (!memberArg && !memberIdArg) {
      return { ok: false, error: `Who would you like to ${isVideo ? 'video' : 'voice'} call?` };
    }
    const resolvedMember = await resolveMember(memberIdArg || memberArg, id, sb);
    if (!resolvedMember.ok) return resolvedMember;
    const target = resolvedMember.member;
    if (target.user_id === id.user_id) {
      return { ok: false, error: "You can't call yourself." };
    }
    const name = memberDisplay(target);
    const kindWord = isVideo ? 'video call' : 'voice call';

    if (args.confirmed !== true) {
      return {
        ok: true,
        result: { stage: 'awaiting_confirmation', recipient_user_id: target.user_id, recipient_label: name },
        text:
          `Vitana can't place a live ${kindWord} for you — calls only work between two people who both have ` +
          `the app open. I can send ${name} a ${kindWord} request instead. Confirm with the user, then call ` +
          `${tool} again with confirmed=true.`,
      };
    }

    const tenantId = await resolveTenantId(id, sb);
    if (!tenantId) {
      return {
        ok: false,
        error: "I can't send that right now — I'm missing some account context. Try once more in a moment.",
      };
    }

    const quota = await checkVoiceSendQuota({
      session_id: `${id.user_id}:${tool}`,
      actor_id: id.user_id,
      vitana_id: id.vitana_id ?? null,
      recipient_user_id: target.user_id,
      recipient_vitana_id: target.vitana_id,
      kind: 'message',
    });
    if (!quota.allowed) {
      return {
        ok: true,
        result: { rate_limited: true, reason: quota.reason },
        text: `Couldn't send (${quota.reason ?? 'rate-limited'}). Try again in a bit.`,
      };
    }

    const senderName = await senderDisplayName(sb, id.user_id);
    const content = `${isVideo ? '🎥' : '📞'} ${senderName} would like to start a ${kindWord} with you — open Vitana to connect.`;
    const { error: insErr } = await sb.from('chat_messages').insert({
      tenant_id: tenantId,
      sender_id: id.user_id,
      receiver_id: target.user_id,
      content,
      message_type: 'call_invite',
      metadata: { source: 'voice', kind: 'call_invite', call_type: isVideo ? 'video' : 'voice' },
    });
    if (insErr) {
      return { ok: false, error: "I couldn't send that request just now — want me to try again?" };
    }

    try {
      notifyUserAsync(
        target.user_id,
        tenantId,
        'new_chat_message',
        {
          title: senderName,
          body: content,
          data: { type: 'new_chat_message', sender_id: id.user_id, url: `/inbox?peer=${id.user_id}` },
        },
        sb,
      );
    } catch {
      /* push is best-effort */
    }

    return {
      ok: true,
      result: { sent: true, recipient_user_id: target.user_id, call_type: isVideo ? 'video' : 'voice' },
      text:
        `I've sent ${name} a ${kindWord} request — real-time calls need both of you in the app, so ask them ` +
        `to open Vitana, or open it yourself to start the call.`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : `${tool} error`;
    return { ok: false, error: `I hit a snag with that call request (${msg}).` };
  }
}

export const tool_start_voice_call: Handler = (args, id, sb) => sendCallInvite(false, args, id, sb);
export const tool_start_video_call: Handler = (args, id, sb) => sendCallInvite(true, args, id, sb);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const MESSAGING_DEPTH_TOOL_HANDLERS: Record<string, Handler> = {
  send_group_chat_message: tool_send_group_chat_message,
  reply_to_message: tool_reply_to_message,
  react_to_message: tool_react_to_message,
  create_group_chat: tool_create_group_chat,
  add_group_chat_member: tool_add_group_chat_member,
  leave_group_chat: tool_leave_group_chat,
  send_calendar_invite_in_chat: tool_send_calendar_invite_in_chat,
  start_voice_call: tool_start_voice_call,
  start_video_call: tool_start_video_call,
};

export const MESSAGING_DEPTH_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'send_group_chat_message',
    description: [
      "Send a text message to a group chat the user is a member of (not a 1-to-1 DM —",
      'use send_chat_message for that). ALWAYS call once WITHOUT confirmed first — the',
      'tool returns a preview; read it back and only call again with confirmed:true after',
      'explicit confirmation.',
      'CALL WHEN the user says: "message the running group", "tell everyone in Alle',
      'Beisammen ...", "schreib in die Gruppe ...".',
      'If several of the user\'s groups match, read the candidates and ask which one.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Spoken group chat name (fuzzy matched among the user\'s own groups).' },
        group_id: { type: 'string', description: 'Exact group UUID when already known.' },
        message: { type: 'string', description: 'The message to send.' },
        confirmed: { type: 'boolean', description: 'Pass true ONLY after the user confirmed the exact wording.' },
      },
      required: ['message'],
    },
  },
  {
    name: 'reply_to_message',
    description: [
      'Reply to a specific earlier message. NOTE: Vitana chat has no reply/quote-thread',
      'feature yet — this tool always answers that it is unavailable. Relay that plainly',
      'and offer send_chat_message or send_group_chat_message instead, optionally quoting',
      'the original text inline in the new message.',
      'CALL WHEN the user says: "reply to that message", "antworte auf die Nachricht".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'UUID of the message being replied to, if known.' },
        message: { type: 'string', description: 'The reply text the user wants to send.' },
      },
      required: [],
    },
  },
  {
    name: 'react_to_message',
    description: [
      'Add (or remove) an emoji reaction on a chat message — one of 👍 ❤️ 😂 😮 🙏 🎉 only.',
      'Requires message_id from a previous tool result (e.g. from list_conversations or a',
      'group message read-back).',
      'CALL WHEN the user says: "react with a heart to that", "give that a thumbs up",',
      '"reagiere mit einem Herz darauf".',
      'Set remove:true to take the reaction back off.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'UUID of the message to react to.' },
        emoji: { type: 'string', description: 'One of: 👍 ❤️ 😂 😮 🙏 🎉' },
        remove: { type: 'boolean', description: 'Pass true to remove a reaction the user previously added.' },
      },
      required: ['message_id', 'emoji'],
    },
  },
  {
    name: 'create_group_chat',
    description: [
      'Create a new group chat, optionally adding named members immediately. ALWAYS call',
      'once WITHOUT confirm first — the tool returns a confirmation question; after the',
      'user says yes, call again with confirm:true.',
      'CALL WHEN the user says: "create a group chat called ...", "start a new chat with',
      'me, Anna and Ben", "erstelle einen Gruppenchat ...".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The group chat name.' },
        description: { type: 'string', description: 'Optional short description.' },
        members: {
          type: 'array',
          items: { type: 'string' },
          description: 'Spoken names of members to add immediately (fuzzy resolved).',
        },
        confirm: { type: 'boolean', description: 'Pass true ONLY after the user confirmed the creation.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_group_chat_member',
    description: [
      'Add a community member to a group chat the user already belongs to.',
      'CALL WHEN the user says: "add Anna to the running group chat", "füge Anna dem',
      'Gruppenchat hinzu".',
      'If several of the user\'s groups or several matching members are found, ask which one.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Spoken group chat name (fuzzy matched among the user\'s own groups).' },
        group_id: { type: 'string', description: 'Exact group UUID when already known.' },
        member: { type: 'string', description: 'Spoken name or Vitana ID of the member to add.' },
        member_user_id: { type: 'string', description: 'UUID of the member if already resolved.' },
      },
      required: [],
    },
  },
  {
    name: 'leave_group_chat',
    description: [
      'Leave a group chat. ALWAYS call once WITHOUT confirm first — the tool returns a',
      'confirmation question; after the user says yes, call again with the group_id and',
      'confirm:true.',
      'CALL WHEN the user says: "leave the running group chat", "verlasse den Gruppenchat',
      '...".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Spoken group chat name (fuzzy matched among the user\'s own groups).' },
        group_id: { type: 'string', description: 'Exact group UUID when already known.' },
        confirm: { type: 'boolean', description: 'Pass true ONLY after the user confirmed leaving.' },
      },
      required: [],
    },
  },
  {
    name: 'send_calendar_invite_in_chat',
    description: [
      'Share one of the user\'s own upcoming calendar events with a community member via',
      'direct message. ALWAYS call once WITHOUT confirmed first — the tool returns a',
      'preview; after explicit confirmation call again with confirmed:true.',
      'CALL WHEN the user says: "send Anna the invite for my yoga session", "share my',
      'appointment with Ben", "schick Anna die Einladung zu meinem Termin".',
      'If several events or member matches are found, ask which one.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        member: { type: 'string', description: 'Spoken name or Vitana ID of the recipient.' },
        member_user_id: { type: 'string', description: 'UUID of the recipient if already resolved.' },
        event: { type: 'string', description: 'Spoken event title (fuzzy matched against the user\'s own upcoming events).' },
        event_id: { type: 'string', description: 'Exact calendar_events UUID when already known.' },
        confirmed: { type: 'boolean', description: 'Pass true ONLY after the user explicitly confirmed sending.' },
      },
      required: [],
    },
  },
  {
    name: 'start_voice_call',
    description: [
      'Send another community member a request to start a voice call. IMPORTANT: Vitana',
      'cannot place a live call from voice — calling only works client-side between two',
      'open apps. This tool sends a chat message + notification asking them to open the',
      'app; it never connects a call. ALWAYS call once WITHOUT confirmed first, then again',
      'with confirmed:true after explicit confirmation.',
      'CALL WHEN the user says: "call Anna", "start a voice call with Ben", "ruf Anna an".',
      'Afterwards, tell the user the request was sent and real-time calling needs both',
      'people in the app.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        member: { type: 'string', description: 'Spoken name or Vitana ID of the person to call.' },
        member_user_id: { type: 'string', description: 'UUID of the member if already resolved.' },
        confirmed: { type: 'boolean', description: 'Pass true ONLY after the user explicitly confirmed sending the request.' },
      },
      required: [],
    },
  },
  {
    name: 'start_video_call',
    description: [
      'Send another community member a request to start a video call. IMPORTANT: Vitana',
      'cannot place a live call from voice — calling only works client-side between two',
      'open apps. This tool sends a chat message + notification asking them to open the',
      'app; it never connects a call. ALWAYS call once WITHOUT confirmed first, then again',
      'with confirmed:true after explicit confirmation.',
      'CALL WHEN the user says: "video call Anna", "start a video chat with Ben", "starte',
      'einen Videoanruf mit Anna".',
      'Afterwards, tell the user the request was sent and real-time calling needs both',
      'people in the app.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        member: { type: 'string', description: 'Spoken name or Vitana ID of the person to video call.' },
        member_user_id: { type: 'string', description: 'UUID of the member if already resolved.' },
        confirmed: { type: 'boolean', description: 'Pass true ONLY after the user explicitly confirmed sending the request.' },
      },
      required: [],
    },
  },
];
