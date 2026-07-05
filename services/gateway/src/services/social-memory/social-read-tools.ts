/**
 * BOOTSTRAP-SOCIAL-READ-TOOLS — the missing READ capabilities
 * (docs/CONVERSATION_DEFECTS_FIX_PLAN.md defects 1, 4, 5).
 *
 * Vitana could SEND (send_chat_message) and SEARCH (search_community,
 * find_community_member) but had no way to READ her user's own inbox,
 * followers, or recent conversations — so she hallucinated ("archived
 * messages"), mis-bound internal messages to Google/connected-apps, and
 * deflected ("kann ich dir nicht direkt sagen"). These four tools close
 * that gap, reusing the social-memory repository (privacy filters,
 * blocked-user exclusion, own-conversations-only) instead of new queries.
 *
 * Contract: every result is SPEAKABLE — names, counts, snippets in
 * plain text the model can voice directly. Internal Maxina data only:
 * no Google account involved, ever. Only "unread" and "all" message
 * views exist — "archived" does not and must never be offered.
 *
 * Privacy: exclusions FAIL CLOSED (repository throws → structured
 * error, no data), mirroring the social-context-builder contract.
 * Snippets are only ever from the user's OWN conversations.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../lib/supabase';
import {
  fetchExclusions,
  fetchFollowEdges,
  fetchRecentMessageContacts,
  fetchPeople,
} from './social-memory-repository';
import type { SocialPerson } from './social-memory-types';

export interface SocialReadIdentity {
  user_id?: string | null;
  tenant_id?: string | null;
}

/** Discriminated union matching the shared OrbToolResult contract. */
export type SocialReadResult =
  | { ok: true; text: string; result: Record<string, unknown> }
  | { ok: false; error: string };

const SNIPPET_CHARS = 90;

function personName(p: SocialPerson | undefined, fallback = 'a member'): string {
  return p?.display_name || p?.handle || fallback;
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${Math.max(1, mins)} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** LLM-facing guardrails appended to every messages answer. */
const MESSAGES_RULES =
  'RULES: These are INTERNAL Maxina community messages — reading them needs NO Google/Gmail/connected-apps account; NEVER mention Google for community messages. ' +
  'Only "unread" and "all" views exist — NEVER offer or mention "archived" messages. ' +
  'To reply, use send_chat_message. Speak senders and counts naturally in the user\'s language.';

/**
 * view_messages — the user's own inbox, speakable (defects 1 + 4).
 * scope: 'unread' (default) | 'all' (recent 30 days).
 */
export async function runViewMessages(
  args: { scope?: unknown; limit?: unknown },
  identity: SocialReadIdentity,
  _sb?: SupabaseClient,
): Promise<SocialReadResult> {
  if (!identity.user_id || !identity.tenant_id) {
    return { ok: false, error: 'view_messages requires an authenticated user.' };
  }
  const supabase = getSupabase();
  if (!supabase) return { ok: false, error: 'view_messages: storage unavailable.' };
  const scope = args.scope === 'all' ? 'all' : 'unread';
  const limitRaw = Number(args.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 50 ? limitRaw : 30;

  // FAIL CLOSED on privacy filters — never show content from blocked users.
  let blocked: Set<string>;
  try {
    blocked = (await fetchExclusions(identity.user_id)).blocked;
  } catch (err: any) {
    return {
      ok: false,
      error: `view_messages: privacy filters unavailable (${err?.message}). Tell the user honestly you cannot read messages right now — do not guess.`,
    };
  }

  let q = supabase
    .from('chat_messages')
    .select('sender_id, content, created_at, read_at')
    .eq('tenant_id', identity.tenant_id)
    .eq('receiver_id', identity.user_id)
    .is('group_id', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (scope === 'unread') q = q.is('read_at', null);
  const { data, error } = await q;
  if (error) return { ok: false, error: `view_messages: ${error.message}` };

  const rows = ((data ?? []) as Array<{
    sender_id: string;
    content: string | null;
    created_at: string;
    read_at: string | null;
  }>).filter((r) => !blocked.has(r.sender_id));

  if (rows.length === 0) {
    return {
      ok: true,
      text:
        (scope === 'unread'
          ? 'The user has NO unread messages right now.'
          : 'The user has no recent messages.') +
        ' Say so plainly. ' +
        MESSAGES_RULES,
      result: { scope, total: 0, senders: [] },
    };
  }

  const bySender = new Map<string, { count: number; latest: string; latest_at: string }>();
  for (const r of rows) {
    const e = bySender.get(r.sender_id);
    if (e) e.count += 1;
    else {
      bySender.set(r.sender_id, {
        count: 1,
        latest: (r.content || '').slice(0, SNIPPET_CHARS),
        latest_at: r.created_at,
      });
    }
  }
  const people = await fetchPeople(Array.from(bySender.keys()));

  const senderLines = Array.from(bySender.entries()).map(([uid, e]) => {
    const name = personName(people.get(uid));
    const snippet = e.latest ? ` — latest: "${e.latest}"` : '';
    return `${name} (${e.count}, ${timeAgo(e.latest_at)}${snippet})`;
  });

  const label = scope === 'unread' ? 'unread message(s)' : 'recent message(s)';
  return {
    ok: true,
    text:
      `The user has ${rows.length} ${label} from ${bySender.size} person(s): ` +
      `${senderLines.join('; ')}. ` +
      MESSAGES_RULES,
    result: {
      scope,
      total: rows.length,
      senders: Array.from(bySender.entries()).map(([uid, e]) => ({
        user_id: uid,
        name: personName(people.get(uid)),
        count: e.count,
        latest_at: e.latest_at,
      })),
    },
  };
}

/**
 * list_followers / list_following — the user's own social graph (defect 5).
 */
export async function runListFollows(
  direction: 'followers' | 'following',
  identity: SocialReadIdentity,
): Promise<SocialReadResult> {
  if (!identity.user_id) {
    return { ok: false, error: `list_${direction} requires an authenticated user.` };
  }
  let blocked: Set<string>;
  try {
    blocked = (await fetchExclusions(identity.user_id)).blocked;
  } catch (err: any) {
    return {
      ok: false,
      error: `list_${direction}: privacy filters unavailable (${err?.message}). Tell the user honestly — do not guess.`,
    };
  }
  const edges = await fetchFollowEdges(identity.user_id, blocked, 50);
  const list = direction === 'followers' ? edges.followers : edges.following;
  const otherList = direction === 'followers' ? edges.following : edges.followers;
  const otherIds = new Set(otherList.map((e) => e.person.user_id));
  const mutuals = list.filter((e) => otherIds.has(e.person.user_id)).length;

  if (list.length === 0) {
    return {
      ok: true,
      text:
        direction === 'followers'
          ? 'Nobody follows the user yet. Answer plainly and, if it fits, suggest posting or joining an activity to get discovered — never deflect to "search the member list".'
          : 'The user does not follow anyone yet. Answer plainly and, if it fits, offer to find interesting members to follow.',
      result: { direction, count: 0, names: [] },
    };
  }

  const names = list.slice(0, 12).map((e) => personName(e.person));
  const more = list.length > names.length ? ` and ${list.length - names.length} more` : '';
  const who = direction === 'followers' ? `${list.length} member(s) follow the user` : `the user follows ${list.length} member(s)`;
  return {
    ok: true,
    text:
      `${who}: ${names.join(', ')}${more}. ${mutuals > 0 ? `${mutuals} of them are mutual. ` : ''}` +
      'Answer the question directly with the count and a few names — NEVER say you cannot tell, and NEVER deflect to a manual member search.',
    result: {
      direction,
      count: list.length,
      mutual_count: mutuals,
      names,
      people: list.slice(0, 12).map((e) => ({ user_id: e.person.user_id, name: personName(e.person) })),
    },
  };
}

/**
 * recent_conversations — who the user last chatted with (defect 5,
 * "sag mit wem ich zuletzt geschrieben habe").
 */
export async function runRecentConversations(
  args: { limit?: unknown },
  identity: SocialReadIdentity,
): Promise<SocialReadResult> {
  if (!identity.user_id || !identity.tenant_id) {
    return { ok: false, error: 'recent_conversations requires an authenticated user.' };
  }
  let blocked: Set<string>;
  try {
    blocked = (await fetchExclusions(identity.user_id)).blocked;
  } catch (err: any) {
    return {
      ok: false,
      error: `recent_conversations: privacy filters unavailable (${err?.message}). Tell the user honestly — do not guess.`,
    };
  }
  const limitRaw = Number(args.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 15 ? limitRaw : 8;
  const contacts = await fetchRecentMessageContacts(
    identity.user_id,
    identity.tenant_id,
    blocked,
    limit,
  );
  if (contacts.length === 0) {
    return {
      ok: true,
      text: 'The user has no direct-message conversations in the last 30 days. Say so plainly; offer to help start one (send_chat_message) if it fits.',
      result: { count: 0, contacts: [] },
    };
  }
  const lines = contacts.map((c) => {
    const dir = c.last_direction === 'sent' ? 'user wrote last' : 'they wrote last';
    const snippet = c.last_snippet ? ` — "${c.last_snippet.slice(0, SNIPPET_CHARS)}"` : '';
    return `${personName(c.person)} (${timeAgo(c.last_message_at)}, ${dir}${snippet})`;
  });
  return {
    ok: true,
    text:
      `The user's most recent conversations, newest first: ${lines.join('; ')}. ` +
      'The FIRST entry answers "who did I last chat with". These are internal Maxina messages (no Google involved). To continue one, use send_chat_message.',
    result: {
      count: contacts.length,
      contacts: contacts.map((c) => ({
        user_id: c.person.user_id,
        name: personName(c.person),
        last_message_at: c.last_message_at,
        last_direction: c.last_direction,
      })),
    },
  };
}
