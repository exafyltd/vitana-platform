/**
 * VTID-04926: member @mentions in group chat messages.
 *
 * The client sends the members it tagged as `content_data.mentions`
 * ([{ user_id, display_name }]). Nothing from the client is trusted as-is:
 * `sanitizeMentions` keeps only well-formed entries for members of this group
 * whose `@display_name` really appears in the text, never the sender, the
 * Vitana bot, or a service/test account (CLAUDE.md rules 43–45). The result
 * replaces whatever the client sent in the stored message metadata, and its
 * user ids decide who gets a `chat_mention` push instead of the generic
 * `new_chat_message` one.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isVitanaBot } from './vitana-bot';

export interface ChatMention {
  user_id: string;
  display_name: string;
}

export const MAX_CHAT_MENTIONS = 20;
const MAX_NAME_LENGTH = 80;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SanitizeMentionsInput {
  raw: unknown;
  content: string;
  senderId: string;
  memberIds: ReadonlySet<string>;
  /** Service and test accounts — never mentionable. */
  excludedIds: ReadonlySet<string>;
}

export function sanitizeMentions({ raw, content, senderId, memberIds, excludedIds }: SanitizeMentionsInput): ChatMention[] {
  if (!Array.isArray(raw) || !content) return [];
  const out: ChatMention[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, MAX_CHAT_MENTIONS * 2)) {
    if (!entry || typeof entry !== 'object') continue;
    const userId = (entry as { user_id?: unknown }).user_id;
    const name = (entry as { display_name?: unknown }).display_name;
    if (typeof userId !== 'string' || !UUID_RE.test(userId)) continue;
    if (typeof name !== 'string') continue;
    const displayName = name.trim();
    if (!displayName || displayName.length > MAX_NAME_LENGTH) continue;
    if (seen.has(userId) || userId === senderId || isVitanaBot(userId)) continue;
    if (!memberIds.has(userId) || excludedIds.has(userId)) continue;
    if (!content.includes(`@${displayName}`)) continue;
    seen.add(userId);
    out.push({ user_id: userId, display_name: displayName });
    if (out.length >= MAX_CHAT_MENTIONS) break;
  }
  return out;
}

/**
 * Of `userIds`, the ones that must never be mentioned or offered as a mention:
 * registered service accounts (`service_bot_accounts`, VTID-03990) and test
 * accounts (`notification_test_actors`, VTID-03506). Throws if either lookup
 * fails, so callers can fail closed (drop all mentions) instead of tagging an
 * account that should never surface to a member.
 */
export async function fetchUnmentionableIds(supabase: SupabaseClient, userIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (userIds.length === 0) return out;
  const [bots, testers] = await Promise.all([
    supabase.from('service_bot_accounts').select('user_id').in('user_id', userIds),
    supabase.from('notification_test_actors').select('user_id').in('user_id', userIds),
  ]);
  for (const res of [bots, testers]) {
    if (res.error) throw new Error(`unmentionable lookup failed: ${res.error.message}`);
    for (const row of (res.data || []) as Array<{ user_id: string }>) out.add(row.user_id);
  }
  return out;
}
