/**
 * Chat management (VTID-02771) + Privacy (VTID-02776) voice tools.
 *
 * Chat tools operate on the canonical peer-to-peer DM store: `chat_messages`
 * (tenant_id, sender_id, receiver_id, content, read_at, created_at, group_id
 * — see supabase/migrations/20260225200000_chat_messages.sql and
 * 20260525000000_VTID_03089_chat_groups.sql). There is NO conversations
 * table for DMs — a "conversation" is the set of messages between two users,
 * and the only per-participant state is `read_at` on received rows. Muting /
 * archiving a chat thread has no backing column anywhere in the schema, so
 * those two tools return an honest "not supported yet" answer instead of
 * inventing columns.
 *
 * Privacy tools operate on `profiles.account_visibility` (per-field jsonb
 * tier map, private | connections | public — vitana-v1 migration
 * 20260421000000_add_account_profile_fields.sql, server mirror in
 * src/lib/account-visibility.ts) and on `user_blocked_authors`
 * (vitana-v1 migration 20260622130000_vtid_03319_phase2_feed_safety.sql;
 * already read by the gateway's social-memory exclusion filters).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { FIELD_DEFAULTS, HARDCODED_KEYS, type FieldVisibility } from '../../lib/account-visibility';
import { runRecentConversations } from '../social-memory/social-read-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface ResolvedMember {
  user_id: string;
  display_name: string | null;
  vitana_id: string | null;
}

function memberDisplay(m: ResolvedMember): string {
  return m.display_name || m.vitana_id || 'that member';
}

/** First non-empty string among the given arg keys. */
function argString(args: OrbToolArgs, ...keys: string[]): string {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * Tenant backfill — voice sessions sometimes carry a null tenant_id even when
 * app_users has one (same recovery tool_send_chat_message does; the
 * chat_messages table is tenant-scoped so we cannot query without it).
 */
async function resolveTenantId(
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<string | null> {
  if (id.tenant_id) return id.tenant_id;
  const { data } = await sb
    .from('app_users')
    .select('tenant_id')
    .eq('user_id', id.user_id)
    .maybeSingle();
  return (data as { tenant_id?: string } | null)?.tenant_id ?? null;
}

/**
 * Resolve a spoken name / Vitana ID / UUID to a single confident member.
 * Uses the same canonical RPC as tool_resolve_recipient
 * (resolve_recipient_candidates) with the same 0.85 confidence / ambiguity
 * thresholds, so "who the user means" is identical across surfaces.
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
  const ambiguous =
    topScore < 0.85 || secondScore / Math.max(topScore, 0.0001) > 0.85;
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

// ---------------------------------------------------------------------------
// Chat tools (VTID-02771)
// ---------------------------------------------------------------------------

/**
 * start_conversation — start (or reuse) a DM with a named member and
 * optionally send a first message.
 *
 * With a message: delegates to the hardened tool_send_chat_message path
 * (label re-resolution, receiver verification, quota, push notify) via a
 * runtime import of orb-tools-shared — dynamic so the parent's value-import
 * of this module doesn't create a load-time require cycle.
 * Without a message: resolves the member and reports whether a conversation
 * already exists, handing the model the recipient_user_id for the send turn.
 */
export const tool_start_conversation: Handler = async (args, id, sb) => {
  if (!id.user_id) {
    return { ok: false, error: 'start_conversation requires an authenticated user.' };
  }
  try {
    const memberArg = argString(
      args,
      'member',
      'member_name',
      'name',
      'spoken_name',
      'recipient_label',
    );
    const memberIdArg = argString(args, 'member_user_id', 'recipient_user_id');
    const message = argString(args, 'message', 'first_message', 'body');

    if (message) {
      // Reuse the full hardened send path (resolution, validation, quota,
      // notification). It accepts either a UUID or a spoken label.
      const shared = await import('../orb-tools-shared');
      return shared.tool_send_chat_message(
        {
          recipient_user_id: memberIdArg || undefined,
          recipient_label: memberArg || undefined,
          body: message,
        },
        id,
        sb,
      );
    }

    const resolved = await resolveMember(memberIdArg || memberArg, id, sb);
    if (!resolved.ok) return resolved;
    const member = resolved.member;
    if (member.user_id === id.user_id) {
      return { ok: false, error: "You can't start a conversation with yourself." };
    }

    const tenantId = await resolveTenantId(id, sb);
    if (!tenantId) {
      return {
        ok: false,
        error: "I can't open a conversation right now — I'm missing some account context. Try once more in a moment.",
      };
    }

    const { data: lastRows, error: lastErr } = await sb
      .from('chat_messages')
      .select('id, content, created_at')
      .eq('tenant_id', tenantId)
      .or(
        `and(sender_id.eq.${id.user_id},receiver_id.eq.${member.user_id}),and(sender_id.eq.${member.user_id},receiver_id.eq.${id.user_id})`,
      )
      .order('created_at', { ascending: false })
      .limit(1);
    if (lastErr) {
      return { ok: false, error: 'I had a problem checking your chats — want me to try again?' };
    }
    const existing = (lastRows || [])[0] as { created_at?: string } | undefined;
    const name = memberDisplay(member);
    const text = existing
      ? `You already have a conversation with ${name} (last message ${new Date(existing.created_at ?? '').toDateString()}). What would you like to say? I'll send it with send_chat_message.`
      : `${name} is in the community and ready to chat — no conversation yet. What should the first message say? I'll send it with send_chat_message.`;
    return {
      ok: true,
      result: {
        recipient_user_id: member.user_id,
        recipient_vitana_id: member.vitana_id,
        recipient_display_name: member.display_name,
        existing_conversation: Boolean(existing),
      },
      text,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'start_conversation error';
    return { ok: false, error: `I hit a snag starting that conversation (${msg}).` };
  }
};

/**
 * list_conversations — recent DM conversations with last-message snippets.
 * Thin wrapper over the canonical runRecentConversations (blocked-user
 * exclusion, fail-closed privacy, speakable output) with tenant backfill.
 */
export const tool_list_conversations: Handler = async (args, id, sb) => {
  if (!id.user_id) {
    return { ok: false, error: 'list_conversations requires an authenticated user.' };
  }
  try {
    const tenantId = await resolveTenantId(id, sb);
    if (!tenantId) {
      return {
        ok: false,
        error: "I can't read your conversations right now — I'm missing some account context. Try once more in a moment.",
      };
    }
    return await runRecentConversations(
      { limit: args.limit },
      { user_id: id.user_id, tenant_id: tenantId },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'list_conversations error';
    return { ok: false, error: `I couldn't read your conversations just now (${msg}).` };
  }
};

/**
 * mark_conversation_read — set read_at on unread DMs. Per-participant read
 * state lives on the chat_messages rows themselves (read_at, receiver-only —
 * same mutation as the frontend's POST /api/v1/chat/read and /read-all).
 * With a member: marks that thread. Without (or all=true): marks everything.
 */
export const tool_mark_conversation_read: Handler = async (args, id, sb) => {
  if (!id.user_id) {
    return { ok: false, error: 'mark_conversation_read requires an authenticated user.' };
  }
  try {
    const tenantId = await resolveTenantId(id, sb);
    if (!tenantId) {
      return {
        ok: false,
        error: "I can't update your messages right now — I'm missing some account context. Try once more in a moment.",
      };
    }
    const memberArg = argString(args, 'member', 'member_name', 'name', 'peer');
    const memberIdArg = argString(args, 'member_user_id', 'peer_id');
    const markAll = args.all === true || (!memberArg && !memberIdArg);

    if (markAll) {
      const { error, count } = await sb
        .from('chat_messages')
        .update({ read_at: new Date().toISOString() }, { count: 'exact' })
        .eq('tenant_id', tenantId)
        .eq('receiver_id', id.user_id)
        .is('read_at', null);
      if (error) {
        return { ok: false, error: "I couldn't mark your messages read just now — want me to try again?" };
      }
      const n = count ?? 0;
      return {
        ok: true,
        result: { scope: 'all', updated: n },
        text: n > 0 ? `Done — marked ${n} unread message(s) as read.` : 'You had no unread messages — nothing to mark.',
      };
    }

    const resolved = await resolveMember(memberIdArg || memberArg, id, sb);
    if (!resolved.ok) return resolved;
    const member = resolved.member;
    const { error, count } = await sb
      .from('chat_messages')
      .update({ read_at: new Date().toISOString() }, { count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('sender_id', member.user_id)
      .eq('receiver_id', id.user_id)
      .is('read_at', null);
    if (error) {
      return { ok: false, error: "I couldn't mark that conversation read just now — want me to try again?" };
    }
    const n = count ?? 0;
    const name = memberDisplay(member);
    return {
      ok: true,
      result: { scope: 'peer', peer_user_id: member.user_id, updated: n },
      text:
        n > 0
          ? `Done — marked ${n} message(s) from ${name} as read.`
          : `Nothing was unread from ${name} — the conversation is already up to date.`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'mark_conversation_read error';
    return { ok: false, error: `I hit a snag updating that (${msg}).` };
  }
};

/**
 * mute_conversation — graceful "not supported". Verified against the schema:
 * chat_messages / chat_groups / chat_group_members carry no per-participant
 * mute flag (migrations 20260225200000, 20260525000000). user_muted_authors
 * exists but is a FEED-safety control (hides an author's posts), not a chat
 * mute — repurposing it would silently hide their community posts too.
 */
export const tool_mute_conversation: Handler = async (args, _id, _sb) => {
  const who = argString(args, 'member', 'member_name', 'name');
  return {
    ok: true,
    result: { supported: false },
    text:
      `Muting individual chat conversations isn't supported in Vitana yet — chats have no mute setting. ` +
      `If ${who || 'someone'} is bothering you, I can block them entirely (block_user) so their posts and messages stop reaching you. Offer that; do not pretend the chat was muted.`,
  };
};

/**
 * archive_conversation — graceful "not supported". No archived flag exists
 * anywhere in the chat schema, and the messaging read tools explicitly forbid
 * offering "archived" messages (see social-read-tools MESSAGES_RULES).
 */
export const tool_archive_conversation: Handler = async (_args, _id, _sb) => {
  return {
    ok: true,
    result: { supported: false },
    text:
      'Archiving chat conversations isn\'t supported in Vitana yet — there is no "archived" state for chats. ' +
      'Say so plainly. The user can mark a conversation read (mark_conversation_read) or block a member (block_user) instead. Never claim messages were archived.',
  };
};

// ---------------------------------------------------------------------------
// Privacy tools (VTID-02776)
// ---------------------------------------------------------------------------

/** Spoken tier → canonical account_visibility tier. */
function normalizeVisibility(raw: string): FieldVisibility | null {
  const v = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (v === 'public' || v === 'everyone') return 'public';
  if (v === 'followers_only' || v === 'followers' || v === 'connections' || v === 'connections_only') {
    return 'connections';
  }
  if (v === 'private' || v === 'only_me' || v === 'nobody' || v === 'hidden') return 'private';
  return null;
}

const TIER_SPOKEN: Record<FieldVisibility, string> = {
  public: 'visible to everyone',
  connections: 'visible to your connections only',
  private: 'private (only you)',
};

/**
 * Read-merge-write helper for profiles.account_visibility (jsonb tier map,
 * keyed by user_id — same column the Privacy & Visibility settings screen
 * writes; server mirror of FIELD_DEFAULTS lives in lib/account-visibility.ts).
 */
async function writeVisibilityMap(
  id: OrbToolIdentity,
  sb: SupabaseClient,
  mutate: (current: Record<string, FieldVisibility>) => Record<string, FieldVisibility>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await sb
    .from('profiles')
    .select('account_visibility')
    .eq('user_id', id.user_id)
    .maybeSingle();
  if (error) {
    return { ok: false, error: "I couldn't read your privacy settings just now — want me to try again?" };
  }
  if (!data) {
    return { ok: false, error: "I couldn't find your profile — try again in a moment." };
  }
  const current = ((data as { account_visibility?: Record<string, FieldVisibility> })
    .account_visibility ?? {}) as Record<string, FieldVisibility>;
  const next = mutate({ ...current });
  const { error: updErr } = await sb
    .from('profiles')
    .update({ account_visibility: next })
    .eq('user_id', id.user_id);
  if (updErr) {
    return { ok: false, error: "I couldn't save your privacy settings just now — want me to try again?" };
  }
  return { ok: true };
}

/**
 * update_account_visibility — set the WHOLE profile to one tier by writing
 * every user-toggleable FIELD_DEFAULTS key into account_visibility (there is
 * no single global visibility column; the per-field jsonb map is the real
 * mechanism). followers_only maps to the schema's 'connections' tier.
 * Confirm-gated: changing all fields at once is a big switch.
 */
export const tool_update_account_visibility: Handler = async (args, id, sb) => {
  if (!id.user_id) {
    return { ok: false, error: 'update_account_visibility requires an authenticated user.' };
  }
  try {
    const tier = normalizeVisibility(argString(args, 'visibility', 'level'));
    if (!tier) {
      return {
        ok: false,
        error: 'Which visibility do you want: public, followers only, or private?',
      };
    }
    if (args.confirm !== true) {
      return {
        ok: true,
        result: { requires_confirmation: true, visibility: tier },
        text:
          `This will make EVERY profile field ${TIER_SPOKEN[tier]} — name, age, location, contact details, preferences. ` +
          `Confirm with the user, then call update_account_visibility again with confirm=true.`,
      };
    }
    const written = await writeVisibilityMap(id, sb, (map) => {
      for (const key of Object.keys(FIELD_DEFAULTS)) {
        if (!HARDCODED_KEYS.has(key)) map[key] = tier;
      }
      return map;
    });
    if (!written.ok) return written;
    return {
      ok: true,
      result: { visibility: tier },
      text: `Done — your profile is now ${TIER_SPOKEN[tier]}. Partner-search posts stay private regardless (safety rule).`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'update_account_visibility error';
    return { ok: false, error: `I hit a snag changing that (${msg}).` };
  }
};

/**
 * Spoken field name → canonical account_visibility key (EN + DE aliases).
 * Keys must exist in FIELD_DEFAULTS — never invent a visibility key.
 */
const PRIVACY_FIELD_ALIASES: Record<string, string> = {
  age: 'derivedAgeBand',
  age_band: 'derivedAgeBand',
  alter: 'derivedAgeBand',
  birthday: 'dateOfBirth',
  birthdate: 'dateOfBirth',
  date_of_birth: 'dateOfBirth',
  geburtstag: 'dateOfBirth',
  geburtsdatum: 'dateOfBirth',
  location: 'city',
  city: 'city',
  stadt: 'city',
  ort: 'city',
  country: 'country',
  land: 'country',
  address: 'address',
  adresse: 'address',
  email: 'email',
  e_mail: 'email',
  phone: 'phone',
  phone_number: 'phone',
  telefon: 'phone',
  gender: 'gender',
  geschlecht: 'gender',
  marital_status: 'maritalStatus',
  familienstand: 'maritalStatus',
  first_name: 'firstName',
  vorname: 'firstName',
  last_name: 'lastName',
  nachname: 'lastName',
  dance: 'dancePreferences',
  dance_preferences: 'dancePreferences',
  tanz: 'dancePreferences',
  partner: 'partnerPreferences',
  partner_preferences: 'partnerPreferences',
  services: 'serviceOfferings',
  service_offerings: 'serviceOfferings',
  posts: 'myPosts',
  my_posts: 'myPosts',
};

const HEALTH_FIELD_TOKENS = new Set(['health', 'health_data', 'gesundheit', 'gesundheitsdaten']);

/**
 * update_privacy_field — set one field's visibility tier in
 * profiles.account_visibility. Only real FIELD_DEFAULTS keys are writable;
 * health data has no profile-visibility key because it never appears on the
 * profile at all.
 */
export const tool_update_privacy_field: Handler = async (args, id, sb) => {
  if (!id.user_id) {
    return { ok: false, error: 'update_privacy_field requires an authenticated user.' };
  }
  try {
    const rawField = argString(args, 'field', 'field_name');
    if (!rawField) {
      return { ok: false, error: 'Which field do you want to change — for example age, location, email, or phone?' };
    }
    const norm = rawField.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (HEALTH_FIELD_TOKENS.has(norm)) {
      return {
        ok: true,
        result: { field: 'health', changed: false },
        text: 'Health data never appears on the profile — it is always private and has no visibility setting to change. Reassure the user.',
      };
    }
    // Exact canonical key (e.g. "dateOfBirth") or spoken alias.
    const key =
      rawField in FIELD_DEFAULTS ? rawField : PRIVACY_FIELD_ALIASES[norm] ?? null;
    if (!key || !(key in FIELD_DEFAULTS)) {
      return {
        ok: false,
        error:
          `"${rawField}" isn't a profile privacy field. You can change: age, birthday, location, country, address, email, phone, gender, name, dance preferences, partner preferences, service offerings, or posts.`,
      };
    }
    if (HARDCODED_KEYS.has(key)) {
      return {
        ok: false,
        error: 'That field is always private for safety and cannot be changed.',
      };
    }
    const tier = normalizeVisibility(argString(args, 'visibility', 'level'));
    if (!tier) {
      return { ok: false, error: 'Which visibility: public, followers only, or private?' };
    }
    const written = await writeVisibilityMap(id, sb, (map) => {
      map[key] = tier;
      return map;
    });
    if (!written.ok) return written;
    return {
      ok: true,
      result: { field: key, visibility: tier },
      text: `Done — your ${rawField} is now ${TIER_SPOKEN[tier]}.`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'update_privacy_field error';
    return { ok: false, error: `I hit a snag changing that (${msg}).` };
  }
};

/**
 * block_user — confirm-gated block via user_blocked_authors (the personal
 * safety table the feed and the messaging read tools already exclude on).
 */
export const tool_block_user: Handler = async (args, id, sb) => {
  if (!id.user_id) {
    return { ok: false, error: 'block_user requires an authenticated user.' };
  }
  try {
    const memberArg = argString(args, 'member', 'member_name', 'name', 'spoken_name');
    const memberIdArg = argString(args, 'member_user_id', 'user_id_to_block');
    const resolved = await resolveMember(memberIdArg || memberArg, id, sb);
    if (!resolved.ok) return resolved;
    const member = resolved.member;
    if (member.user_id === id.user_id) {
      return { ok: false, error: "You can't block yourself." };
    }
    const name = memberDisplay(member);
    if (args.confirm !== true) {
      return {
        ok: true,
        result: {
          requires_confirmation: true,
          member_user_id: member.user_id,
          member_vitana_id: member.vitana_id,
          member_display_name: member.display_name,
        },
        text:
          `Found ${name}${member.vitana_id ? ` (${member.vitana_id})` : ''}. Blocking hides their posts and messages from you. ` +
          `Confirm with the user, then call block_user again with confirm=true and member_user_id=${member.user_id}.`,
      };
    }
    const { error } = await sb
      .from('user_blocked_authors')
      .upsert(
        { user_id: id.user_id, author_id: member.user_id },
        { onConflict: 'user_id,author_id' },
      );
    if (error) {
      return { ok: false, error: `I couldn't block ${name} just now — want me to try again?` };
    }
    return {
      ok: true,
      result: { blocked_user_id: member.user_id, blocked_display_name: member.display_name },
      text: `Done — ${name} is blocked. Their posts and messages won't be shown to you anymore. You can undo this anytime by asking me to unblock them.`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'block_user error';
    return { ok: false, error: `I hit a snag blocking that member (${msg}).` };
  }
};

/**
 * unblock_user — remove a row from user_blocked_authors. Matches the spoken
 * name against the user's OWN blocked list (not the whole community), so an
 * ambiguous community name can't unblock the wrong person.
 */
export const tool_unblock_user: Handler = async (args, id, sb) => {
  if (!id.user_id) {
    return { ok: false, error: 'unblock_user requires an authenticated user.' };
  }
  try {
    const memberArg = argString(args, 'member', 'member_name', 'name', 'spoken_name');
    const memberIdArg = argString(args, 'member_user_id');
    if (!memberArg && !memberIdArg) {
      return { ok: false, error: 'Who would you like to unblock?' };
    }

    const { data: blockedRows, error: blockedErr } = await sb
      .from('user_blocked_authors')
      .select('author_id')
      .eq('user_id', id.user_id)
      .limit(500);
    if (blockedErr) {
      return { ok: false, error: "I couldn't read your blocked list just now — want me to try again?" };
    }
    const blockedIds = ((blockedRows || []) as Array<{ author_id: string }>).map(
      (r) => r.author_id,
    );
    if (blockedIds.length === 0) {
      return {
        ok: true,
        result: { unblocked: false, blocked_count: 0 },
        text: "You haven't blocked anyone — there is nobody to unblock.",
      };
    }

    const { data: peopleRows, error: peopleErr } = await sb
      .from('app_users')
      .select('user_id, display_name, vitana_id')
      .in('user_id', blockedIds);
    if (peopleErr) {
      return { ok: false, error: "I couldn't read your blocked list just now — want me to try again?" };
    }
    const people = (peopleRows || []) as ResolvedMember[];

    let matches: ResolvedMember[];
    if (memberIdArg && UUID_RE.test(memberIdArg)) {
      matches = blockedIds.includes(memberIdArg)
        ? [people.find((p) => p.user_id === memberIdArg) ?? { user_id: memberIdArg, display_name: null, vitana_id: null }]
        : [];
    } else {
      const tokens = memberArg.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
      matches = people.filter((p) => {
        const dn = (p.display_name ?? '').toLowerCase();
        const vid = (p.vitana_id ?? '').toLowerCase();
        return tokens.length > 0 && tokens.every((t) => dn.includes(t) || vid.includes(t));
      });
    }

    const blockedNames = people
      .slice(0, 6)
      .map((p) => memberDisplay(p))
      .join(', ');
    if (matches.length === 0) {
      return {
        ok: true,
        result: { unblocked: false, blocked_count: blockedIds.length },
        text: `${memberArg || 'That member'} isn't on your blocked list. Currently blocked: ${blockedNames}.`,
      };
    }
    if (matches.length > 1) {
      const names = matches.slice(0, 3).map((p) => memberDisplay(p)).join(', ');
      return {
        ok: false,
        error: `Several blocked members match "${memberArg}": ${names}. Which one did you mean?`,
      };
    }

    const target = matches[0];
    const { error: delErr } = await sb
      .from('user_blocked_authors')
      .delete()
      .eq('user_id', id.user_id)
      .eq('author_id', target.user_id);
    if (delErr) {
      return { ok: false, error: `I couldn't unblock ${memberDisplay(target)} just now — want me to try again?` };
    }
    return {
      ok: true,
      result: { unblocked: true, unblocked_user_id: target.user_id },
      text: `Done — ${memberDisplay(target)} is unblocked. You'll see their posts and messages again.`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unblock_user error';
    return { ok: false, error: `I hit a snag unblocking that member (${msg}).` };
  }
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const CHAT_PRIVACY_TOOL_HANDLERS: Record<string, Handler> = {
  start_conversation: tool_start_conversation,
  list_conversations: tool_list_conversations,
  mark_conversation_read: tool_mark_conversation_read,
  mute_conversation: tool_mute_conversation,
  archive_conversation: tool_archive_conversation,
  update_account_visibility: tool_update_account_visibility,
  update_privacy_field: tool_update_privacy_field,
  block_user: tool_block_user,
  unblock_user: tool_unblock_user,
};

export const CHAT_PRIVACY_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'start_conversation',
    description: [
      'Start (or reuse) a direct-message conversation with a named community member,',
      'optionally sending the first message in the same call.',
      'WHEN: "start a chat with Maria", "message Alex for the first time",',
      '"schreib Maria an", "starte eine Unterhaltung mit Alex".',
      'Pass member (spoken name or Vitana ID) or member_user_id (UUID from resolve_recipient).',
      'With message set, it sends immediately via the canonical send path.',
      'Without message, it resolves the member, says whether a conversation already',
      'exists, and returns recipient_user_id — read back the name, ask what to say,',
      'then send with send_chat_message or call this again with message set.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        member: {
          type: 'string',
          description: 'Spoken name or Vitana ID of the member to chat with.',
        },
        member_user_id: {
          type: 'string',
          description: 'UUID of the member if already resolved (preferred over member).',
        },
        message: {
          type: 'string',
          description: 'Optional first message to send immediately. Only pass after the user confirmed the wording.',
        },
      },
      required: [],
    },
  },
  {
    name: 'list_conversations',
    description: [
      'List the user\'s recent direct-message conversations, newest first, with',
      'who wrote last and a short snippet.',
      'WHEN: "show my conversations", "who have I been chatting with?",',
      '"zeig meine Chats", "mit wem habe ich geschrieben?".',
      'These are internal Maxina messages — no Google account involved.',
      'Speak the names and snippets naturally; to continue one, use send_chat_message.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'How many conversations to return, 1-15. Uses a sensible default when omitted.',
        },
      },
      required: [],
    },
  },
  {
    name: 'mark_conversation_read',
    description: [
      'Mark direct messages as read. With member set, marks that conversation;',
      'without it (or with all=true), marks ALL unread messages.',
      'WHEN: "mark my chat with Maria as read", "mark everything read",',
      '"markiere den Chat mit Maria als gelesen", "alles als gelesen markieren".',
      'Afterwards, confirm how many messages were marked.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        member: {
          type: 'string',
          description: 'Spoken name or Vitana ID of the conversation partner. Omit to mark everything.',
        },
        member_user_id: {
          type: 'string',
          description: 'UUID of the conversation partner if already resolved.',
        },
        all: {
          type: 'boolean',
          description: 'Set true to mark every unread message as read.',
        },
      },
      required: [],
    },
  },
  {
    name: 'mute_conversation',
    description: [
      'Mute a chat conversation. NOTE: chat muting is not supported in Vitana yet —',
      'this tool answers honestly and suggests block_user as the stronger alternative.',
      'WHEN: "mute this chat", "mute Maria", "schalte den Chat stumm".',
      'Relay the returned text plainly; never claim the chat was muted.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        member: {
          type: 'string',
          description: 'Spoken name of the conversation partner (used to word the answer).',
        },
      },
      required: [],
    },
  },
  {
    name: 'archive_conversation',
    description: [
      'Archive a chat conversation. NOTE: chat archiving does not exist in Vitana —',
      'this tool answers honestly. Never invent or offer "archived messages".',
      'WHEN: "archive this chat", "archiviere den Chat mit Maria".',
      'Relay the returned text plainly; suggest mark_conversation_read or block_user instead.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        member: {
          type: 'string',
          description: 'Spoken name of the conversation partner (used to word the answer).',
        },
      },
      required: [],
    },
  },
  {
    name: 'update_account_visibility',
    description: [
      'Set the visibility of the user\'s WHOLE profile: public, followers_only, or private.',
      'Writes every per-field visibility setting at once (partner-search posts stay private).',
      'WHEN: "make my profile private", "set my account to public",',
      '"mach mein Profil privat", "stell mein Konto auf öffentlich".',
      'Two-step: first call returns a confirmation request — read it back, get an',
      'explicit yes, then call again with confirm=true. Then confirm the change out loud.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        visibility: {
          type: 'string',
          description: 'One of: public, followers_only, private.',
        },
        confirm: {
          type: 'boolean',
          description: 'Pass true only after the user explicitly confirmed the change.',
        },
      },
      required: ['visibility'],
    },
  },
  {
    name: 'update_privacy_field',
    description: [
      'Set the visibility of ONE profile field: public, followers_only, or private.',
      'Fields: age, birthday, location (city), country, address, email, phone, gender,',
      'first/last name, marital status, dance/partner preferences, service offerings, posts.',
      'WHEN: "hide my age", "make my location visible to followers only",',
      '"verstecke mein Alter", "zeig meine Stadt nur meinen Kontakten".',
      'Health data is always private and has no setting. Confirm the change out loud after.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        field: {
          type: 'string',
          description: 'The field to change, e.g. "age", "location", "email", "phone", "birthday".',
        },
        visibility: {
          type: 'string',
          description: 'One of: public, followers_only, private.',
        },
      },
      required: ['field', 'visibility'],
    },
  },
  {
    name: 'block_user',
    description: [
      'Block a community member so their posts and messages are hidden from the user.',
      'WHEN: "block Maria", "I don\'t want to see Alex anymore",',
      '"blockiere Maria", "ich will nichts mehr von Alex sehen".',
      'Two-step: the first call resolves the member and returns a confirmation request —',
      'read the name back, get an explicit yes, then call again with confirm=true and',
      'the returned member_user_id. Afterwards, confirm the block and mention it can be undone.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        member: {
          type: 'string',
          description: 'Spoken name or Vitana ID of the member to block.',
        },
        member_user_id: {
          type: 'string',
          description: 'UUID of the member (from the confirmation step or resolve_recipient).',
        },
        confirm: {
          type: 'boolean',
          description: 'Pass true only after the user explicitly confirmed the block.',
        },
      },
      required: [],
    },
  },
  {
    name: 'unblock_user',
    description: [
      'Unblock a previously blocked member so their posts and messages show again.',
      'Matches the name against the user\'s own blocked list only.',
      'WHEN: "unblock Maria", "entblockiere Maria", "hebe die Blockierung von Alex auf".',
      'If the name is not on the blocked list, the tool says who currently is —',
      'relay that plainly. Afterwards, confirm the unblock out loud.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        member: {
          type: 'string',
          description: 'Spoken name or Vitana ID of the member to unblock.',
        },
        member_user_id: {
          type: 'string',
          description: 'UUID of the member if known.',
        },
      },
      required: [],
    },
  },
];
