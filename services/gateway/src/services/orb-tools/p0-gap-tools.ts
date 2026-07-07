/**
 * P0 coverage-gap voice tools (BOOTSTRAP-VOICE-P0-GAPS).
 *
 * The community voice-gap analysis found whole daily-use surfaces with no
 * voice path at all: follow/unfollow a member, read/clear notifications, a
 * read-only wallet snapshot, simple own-profile edits, playing an internal
 * Vitana podcast, and liking/commenting on community feed posts. This module
 * closes those gaps with thin handlers over the REAL backings the app already
 * uses: user_follows, user_notifications, wallet balance-service +
 * user_subscriptions, profiles, media_uploads(+podcast_metadata), and
 * profile_posts(+profile_post_likes/profile_post_comments). Public-text
 * mutations (unfollow, profile edit, comment) are confirm-gated with a
 * verbatim read-back, mirroring the create_community_post contract.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';

type Handler = (args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient) => Promise<OrbToolResult>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function strArg(args: OrbToolArgs, ...keys: string[]): string {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** Accept both `confirmed` (create_community_post style) and `confirm`. */
function isConfirmed(args: OrbToolArgs): boolean {
  return args.confirmed === true || args.confirm === true;
}

function errText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** Compact "3 days ago" / "2 hours ago" / "just now" for voice. */
function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

function snippet(content: string, max = 80): string {
  const clean = content.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

interface ResolvedPerson {
  user_id: string;
  display_name: string | null;
}

/**
 * Resolve a community member by spoken name via the privacy-filtered
 * social-memory repository resolver (same source list_followers reads).
 */
async function resolveMember(name: string): Promise<ResolvedPerson | null> {
  const { resolvePersonByName } = await import('../social-memory/social-memory-repository');
  const person = await resolvePersonByName(name);
  if (!person) return null;
  return { user_id: person.user_id, display_name: person.display_name ?? null };
}

// ---------------------------------------------------------------------------
// follow_member / unfollow_member — user_follows(follower_id, following_id)
// ---------------------------------------------------------------------------

export async function tool_follow_member(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'follow_member requires an authenticated user.' };
  const name = strArg(args, 'name', 'member_name', 'query');
  if (!name) return { ok: false, error: 'follow_member requires the member `name` to follow.' };
  try {
    const person = await resolveMember(name);
    if (!person) {
      return {
        ok: true,
        result: { followed: false, reason: 'member_not_found' },
        text: `I couldn't find a community member matching "${name}". Ask the user to repeat or spell the name.`,
      };
    }
    const who = person.display_name || name;
    if (person.user_id === id.user_id) {
      return { ok: true, result: { followed: false, reason: 'self' }, text: 'That is your own profile — you cannot follow yourself.' };
    }
    const { data: existing } = await sb
      .from('user_follows')
      .select('id')
      .eq('follower_id', id.user_id)
      .eq('following_id', person.user_id)
      .maybeSingle();
    if (existing) {
      return { ok: true, result: { followed: true, already: true, user_id: person.user_id }, text: `You already follow ${who}.` };
    }
    const { error } = await sb
      .from('user_follows')
      .insert({ follower_id: id.user_id, following_id: person.user_id });
    if (error) return { ok: false, error: `Could not follow ${who}: ${error.message}` };
    return {
      ok: true,
      result: { followed: true, user_id: person.user_id, display_name: who },
      text: `Done — you are now following ${who}.`,
    };
  } catch (err) {
    return { ok: false, error: errText(err, 'follow_member failed') };
  }
}

export async function tool_unfollow_member(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'unfollow_member requires an authenticated user.' };
  const name = strArg(args, 'name', 'member_name', 'query');
  if (!name) return { ok: false, error: 'unfollow_member requires the member `name` to unfollow.' };
  try {
    const person = await resolveMember(name);
    if (!person) {
      return {
        ok: true,
        result: { unfollowed: false, reason: 'member_not_found' },
        text: `I couldn't find a community member matching "${name}".`,
      };
    }
    const who = person.display_name || name;
    const { data: existing } = await sb
      .from('user_follows')
      .select('id')
      .eq('follower_id', id.user_id)
      .eq('following_id', person.user_id)
      .maybeSingle();
    if (!existing) {
      return { ok: true, result: { unfollowed: false, reason: 'not_following' }, text: `You are not following ${who}, so there is nothing to unfollow.` };
    }
    if (!isConfirmed(args)) {
      return {
        ok: true,
        result: { stage: 'awaiting_confirmation', display_name: who, user_id: person.user_id },
        text: `CONFIRM REQUIRED: Ask the user "Should I unfollow ${who}?" and call unfollow_member again with confirmed=true only after they say yes.`,
      };
    }
    const { error } = await sb
      .from('user_follows')
      .delete()
      .eq('follower_id', id.user_id)
      .eq('following_id', person.user_id);
    if (error) return { ok: false, error: `Could not unfollow ${who}: ${error.message}` };
    return {
      ok: true,
      result: { unfollowed: true, user_id: person.user_id, display_name: who },
      text: `Done — you no longer follow ${who}.`,
    };
  } catch (err) {
    return { ok: false, error: errText(err, 'unfollow_member failed') };
  }
}

// ---------------------------------------------------------------------------
// get_notifications / mark_notifications_read — user_notifications
// ---------------------------------------------------------------------------

interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
}

export async function tool_get_notifications(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id || !id.tenant_id) {
    return { ok: false, error: 'get_notifications requires an authenticated user.' };
  }
  const limitRaw = Number(args.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 20) : 10;
  try {
    const { data, error } = await sb
      .from('user_notifications')
      .select('id, type, title, body, read_at, created_at')
      .eq('user_id', id.user_id)
      .eq('tenant_id', id.tenant_id)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) return { ok: false, error: `Could not read notifications: ${error.message}` };
    const rows = (data ?? []) as NotificationRow[];
    if (rows.length === 0) {
      return { ok: true, result: { notifications: [], unread_count: 0 }, text: 'You have no notifications right now — all clear.' };
    }
    // Unread first, then newest first, capped for voice.
    const sorted = [...rows].sort((a, b) => {
      const ua = a.read_at ? 1 : 0;
      const ub = b.read_at ? 1 : 0;
      if (ua !== ub) return ua - ub;
      return b.created_at.localeCompare(a.created_at);
    });
    const unread = rows.filter((r) => !r.read_at).length;
    const spoken = sorted.slice(0, limit);
    const lines = spoken.map((n) => {
      const when = timeAgo(n.created_at);
      const state = n.read_at ? '' : ' (unread)';
      const body = n.body ? ` — ${snippet(n.body, 60)}` : '';
      return `${n.title}${body}${when ? `, ${when}` : ''}${state}`;
    });
    const head =
      unread > 0
        ? `You have ${unread} unread notification${unread === 1 ? '' : 's'}.`
        : 'No unread notifications — here are your latest.';
    return {
      ok: true,
      result: {
        unread_count: unread,
        notifications: spoken.map((n) => ({
          id: n.id,
          type: n.type,
          title: n.title,
          read: !!n.read_at,
          created_at: n.created_at,
        })),
      },
      text: `${head}\n${lines.join('\n')}`,
    };
  } catch (err) {
    return { ok: false, error: errText(err, 'get_notifications failed') };
  }
}

export async function tool_mark_notifications_read(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id || !id.tenant_id) {
    return { ok: false, error: 'mark_notifications_read requires an authenticated user.' };
  }
  const reference = strArg(args, 'reference', 'title');
  const now = new Date().toISOString();
  try {
    let query = sb
      .from('user_notifications')
      .update({ read_at: now })
      .eq('user_id', id.user_id)
      .eq('tenant_id', id.tenant_id)
      .is('read_at', null);
    if (reference) {
      // Scope to notifications whose title mentions the spoken reference.
      const safe = reference.replace(/[%_,]/g, ' ').trim();
      query = query.ilike('title', `%${safe}%`);
    }
    const { data, error } = await query.select('id');
    if (error) return { ok: false, error: `Could not mark notifications read: ${error.message}` };
    const count = (data ?? []).length;
    if (count === 0) {
      return {
        ok: true,
        result: { marked: 0 },
        text: reference
          ? `I found no unread notification matching "${reference}".`
          : 'There were no unread notifications to mark.',
      };
    }
    return {
      ok: true,
      result: { marked: count },
      text: reference
        ? `Done — marked ${count} notification${count === 1 ? '' : 's'} matching "${reference}" as read.`
        : `Done — marked all ${count} unread notification${count === 1 ? '' : 's'} as read.`,
    };
  } catch (err) {
    return { ok: false, error: errText(err, 'mark_notifications_read failed') };
  }
}

// ---------------------------------------------------------------------------
// get_wallet_balance — READ-ONLY snapshot (wallet_accounts + wallet_ledger_entries
// via wallet/balance-service, user_subscriptions for the active plan)
// ---------------------------------------------------------------------------

export async function tool_get_wallet_balance(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'get_wallet_balance requires an authenticated user.' };
  try {
    const { getAccountsForUser, getTransactionsForUser } = await import('../wallet/balance-service');
    const [accounts, page] = await Promise.all([
      getAccountsForUser(id.user_id),
      getTransactionsForUser({ user_id: id.user_id, limit: 3 }),
    ]);

    // Active subscription (best effort — never block the balance on it).
    interface SubscriptionRow {
      plan_key: string;
      status: string;
      current_period_end: string | null;
    }
    let subscription: SubscriptionRow | null = null;
    try {
      let subQuery = sb
        .from('user_subscriptions')
        .select('plan_key, status, current_period_end')
        .eq('user_id', id.user_id);
      if (id.tenant_id) subQuery = subQuery.eq('tenant_id', id.tenant_id);
      const { data: subRow } = await subQuery.maybeSingle();
      subscription = (subRow as SubscriptionRow | null) ?? null;
    } catch {
      /* subscription read is optional */
    }

    const fmtMinor = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`;

    const balanceLine =
      accounts.length > 0
        ? `Your wallet balance is ${accounts.map((a) => fmtMinor(a.balance_minor, a.currency)).join(' and ')}.`
        : 'Your wallet has no accounts yet — the balance is zero.';

    const subLine =
      subscription && subscription.status !== 'free' && subscription.status !== 'canceled'
        ? ` Your ${subscription.plan_key} subscription is ${subscription.status}${
            subscription.current_period_end
              ? ` until ${new Date(subscription.current_period_end).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`
              : ''
          }.`
        : '';

    const txLine =
      page.entries.length > 0
        ? ` Latest transactions: ${page.entries
            .map((e) => `${e.description || e.entry_type} ${e.direction === 'credit' ? '+' : '-'}${fmtMinor(e.amount_minor, e.currency)}`)
            .join('; ')}.`
        : '';

    return {
      ok: true,
      result: {
        accounts: accounts.map((a) => ({ currency: a.currency, balance_minor: a.balance_minor, status: a.status })),
        subscription,
        recent_transactions: page.entries.map((e) => ({
          entry_type: e.entry_type,
          direction: e.direction,
          amount_minor: e.amount_minor,
          currency: e.currency,
          description: e.description,
          created_at: e.created_at,
        })),
      },
      text: `${balanceLine}${subLine}${txLine} This is read-only — payments and top-ups happen in the Wallet screen.`,
    };
  } catch (err) {
    return { ok: false, error: errText(err, 'get_wallet_balance failed') };
  }
}

// ---------------------------------------------------------------------------
// update_profile — simple own-profile fields on `profiles` (confirm-gated).
// NEVER touches role or visibility (privacy tools own visibility).
// ---------------------------------------------------------------------------

const PROFILE_EDITABLE_FIELDS = ['display_name', 'bio', 'city', 'country', 'location'] as const;

export async function tool_update_profile(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'update_profile requires an authenticated user.' };
  const updates: Record<string, string> = {};
  for (const field of PROFILE_EDITABLE_FIELDS) {
    const v = args[field];
    if (typeof v === 'string' && v.trim()) {
      updates[field] = v.replace(/\s+/g, ' ').trim().slice(0, field === 'bio' ? 1000 : 120);
    }
  }
  if (Object.keys(updates).length === 0) {
    return {
      ok: false,
      error:
        'update_profile requires at least one field to change: display_name, bio, city, country or location. Role and visibility cannot be changed here.',
    };
  }
  try {
    if (!isConfirmed(args)) {
      const readback = Object.entries(updates)
        .map(([k, v]) => `${k.replace('_', ' ')} to "${v}"`)
        .join(', ');
      return {
        ok: true,
        result: { stage: 'awaiting_confirmation', changes: updates },
        text: `CONFIRM REQUIRED: Read the change back verbatim — setting ${readback} — then call update_profile again with confirmed=true after the user agrees.`,
      };
    }
    const { error } = await sb.from('profiles').update(updates).eq('user_id', id.user_id);
    if (error) return { ok: false, error: `Could not update your profile: ${error.message}` };
    const spoken = Object.entries(updates)
      .map(([k, v]) => `${k.replace('_', ' ')} is now "${v}"`)
      .join(', ');
    return {
      ok: true,
      result: { updated: true, changes: updates },
      text: `Done — your ${spoken}.`,
    };
  } catch (err) {
    return { ok: false, error: errText(err, 'update_profile failed') };
  }
}

// ---------------------------------------------------------------------------
// play_podcast — internal Vitana Media Hub podcasts
// (media_uploads media_type='podcast' + podcast_metadata; open_url directive
// like play_music's vitana_hub path)
// ---------------------------------------------------------------------------

interface PodcastRow {
  id: string;
  title: string;
  description: string | null;
  file_url: string;
  thumbnail_url: string | null;
  duration: number | null;
  podcast_metadata:
    | { host_name?: string | null; series_name?: string | null }
    | Array<{ host_name?: string | null; series_name?: string | null }>
    | null;
}

export async function tool_play_podcast(
  args: OrbToolArgs,
  _id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const query = strArg(args, 'query', 'title', 'topic');
  try {
    let q = sb
      .from('media_uploads')
      .select('id, title, description, file_url, thumbnail_url, duration, podcast_metadata(host_name, series_name)')
      .eq('status', 'approved')
      .eq('is_public', true)
      .eq('media_type', 'podcast');
    if (query) {
      const pattern = `%${query.replace(/[\\%_,]/g, ' ').trim()}%`;
      q = q.or(`title.ilike.${pattern},description.ilike.${pattern}`);
    }
    const { data, error } = await q.order('plays_count', { ascending: false }).limit(5);
    if (error) return { ok: false, error: `Podcast search failed: ${error.message}` };
    const rows = (data ?? []) as unknown as PodcastRow[];
    if (rows.length === 0) {
      return {
        ok: true,
        result: { played: false, reason: 'no_match' },
        text: query
          ? `I couldn't find a Vitana podcast matching "${query}". Want me to open the Media Hub so you can browse?`
          : 'There are no podcasts in the Vitana Media Hub yet. Want me to open the Media Hub?',
      };
    }
    const hit = rows[0];
    const meta = Array.isArray(hit.podcast_metadata) ? hit.podcast_metadata[0] : hit.podcast_metadata;
    const host = meta?.host_name || '';
    const series = meta?.series_name || '';
    const directive = {
      type: 'orb_directive',
      directive: 'open_url',
      url: hit.file_url,
      title: hit.title,
      channel: host || series,
      source: 'vitana_hub',
      query,
      vtid: 'BOOTSTRAP-VOICE-P0-GAPS',
    };
    const byLine = host ? ` hosted by ${host}` : series ? ` from the series ${series}` : '';
    return {
      ok: true,
      result: {
        played: true,
        podcast_id: hit.id,
        title: hit.title,
        url: hit.file_url,
        directive, // Vertex emits via SSE/WS; LiveKit publishes over the data channel.
      },
      text: `Now playing the podcast "${hit.title}"${byLine} from the Vitana Media Hub.`,
    };
  } catch (err) {
    return { ok: false, error: errText(err, 'play_podcast failed') };
  }
}

// ---------------------------------------------------------------------------
// like_post / comment_on_post — profile_posts + profile_post_likes /
// profile_post_comments (the community feed tables the app uses; the post
// author is notified by DB triggers on the like/comment tables)
// ---------------------------------------------------------------------------

interface PostRow {
  id: string;
  user_id: string;
  content: string;
  created_at: string;
}

type PostOutcome =
  | { kind: 'found'; post: PostRow; author: ResolvedPerson }
  | { kind: 'no_author' }
  | { kind: 'no_post'; author: ResolvedPerson }
  | { kind: 'error'; message: string };

/** Resolve "the last post from <name>" → most recent matching public post. */
async function resolveAuthorPost(
  sb: SupabaseClient,
  authorName: string,
  postReference: string,
): Promise<PostOutcome> {
  const author = await resolveMember(authorName);
  if (!author) return { kind: 'no_author' };
  const { data, error } = await sb
    .from('profile_posts')
    .select('id, user_id, content, created_at')
    .eq('user_id', author.user_id)
    .eq('is_public', true)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) return { kind: 'error', message: error.message };
  const posts = (data ?? []) as PostRow[];
  if (posts.length === 0) return { kind: 'no_post', author };
  if (postReference) {
    const ref = postReference.toLowerCase();
    const match = posts.find((p) => p.content.toLowerCase().includes(ref));
    if (match) return { kind: 'found', post: match, author };
  }
  return { kind: 'found', post: posts[0], author };
}

export async function tool_like_post(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'like_post requires an authenticated user.' };
  const authorName = strArg(args, 'author_name', 'author', 'name');
  if (!authorName) return { ok: false, error: 'like_post requires `author_name` — whose post should be liked?' };
  const postReference = strArg(args, 'post_reference', 'reference');
  try {
    const outcome = await resolveAuthorPost(sb, authorName, postReference);
    if (outcome.kind === 'no_author') {
      return { ok: true, result: { liked: false, reason: 'member_not_found' }, text: `I couldn't find a community member matching "${authorName}".` };
    }
    if (outcome.kind === 'error') return { ok: false, error: `Could not read posts: ${outcome.message}` };
    const authorDisplay = outcome.author.display_name || authorName;
    if (outcome.kind === 'no_post') {
      return { ok: true, result: { liked: false, reason: 'no_posts' }, text: `${authorDisplay} has no public posts to like right now.` };
    }
    const { post } = outcome;
    const { data: existing } = await sb
      .from('profile_post_likes')
      .select('id')
      .eq('post_id', post.id)
      .eq('user_id', id.user_id)
      .maybeSingle();
    if (existing) {
      return {
        ok: true,
        result: { liked: true, already: true, post_id: post.id },
        text: `You already liked ${authorDisplay}'s post "${snippet(post.content)}".`,
      };
    }
    const { error } = await sb.from('profile_post_likes').insert({ post_id: post.id, user_id: id.user_id });
    if (error) return { ok: false, error: `Could not like the post: ${error.message}` };
    return {
      ok: true,
      result: { liked: true, post_id: post.id, author: authorDisplay },
      text: `Done — you liked ${authorDisplay}'s post "${snippet(post.content)}".`,
    };
  } catch (err) {
    return { ok: false, error: errText(err, 'like_post failed') };
  }
}

export async function tool_comment_on_post(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'comment_on_post requires an authenticated user.' };
  const authorName = strArg(args, 'author_name', 'author', 'name');
  if (!authorName) return { ok: false, error: 'comment_on_post requires `author_name` — whose post should be commented on?' };
  const rawText = strArg(args, 'text', 'comment', 'content');
  if (!rawText) return { ok: false, error: 'comment_on_post requires the comment `text`.' };
  const comment = rawText.replace(/\s+/g, ' ').trim().slice(0, 1000);
  const postReference = strArg(args, 'post_reference', 'reference');
  try {
    const outcome = await resolveAuthorPost(sb, authorName, postReference);
    if (outcome.kind === 'no_author') {
      return { ok: true, result: { commented: false, reason: 'member_not_found' }, text: `I couldn't find a community member matching "${authorName}".` };
    }
    if (outcome.kind === 'error') return { ok: false, error: `Could not read posts: ${outcome.message}` };
    const authorDisplay = outcome.author.display_name || authorName;
    if (outcome.kind === 'no_post') {
      return { ok: true, result: { commented: false, reason: 'no_posts' }, text: `${authorDisplay} has no public posts to comment on right now.` };
    }
    const { post } = outcome;
    if (!isConfirmed(args)) {
      return {
        ok: true,
        result: {
          stage: 'awaiting_confirmation',
          comment_preview: comment,
          post_id: post.id,
          post_snippet: snippet(post.content),
        },
        text: `CONFIRM REQUIRED: Read the comment back verbatim — "${comment}" — on ${authorDisplay}'s post "${snippet(post.content)}", then call comment_on_post again with confirmed=true after the user says post/yes.`,
      };
    }
    const { error } = await sb
      .from('profile_post_comments')
      .insert({ post_id: post.id, user_id: id.user_id, content: comment });
    if (error) return { ok: false, error: `Could not post the comment: ${error.message}` };
    return {
      ok: true,
      result: { commented: true, post_id: post.id, author: authorDisplay, comment },
      text: `Done — your comment is live on ${authorDisplay}'s post.`,
    };
  } catch (err) {
    return { ok: false, error: errText(err, 'comment_on_post failed') };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const P0_GAP_TOOL_HANDLERS: Record<string, Handler> = {
  follow_member: tool_follow_member,
  unfollow_member: tool_unfollow_member,
  get_notifications: tool_get_notifications,
  mark_notifications_read: tool_mark_notifications_read,
  get_wallet_balance: tool_get_wallet_balance,
  update_profile: tool_update_profile,
  play_podcast: tool_play_podcast,
  like_post: tool_like_post,
  comment_on_post: tool_comment_on_post,
};

export const P0_GAP_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'follow_member',
    description: [
      'FOLLOW a community member by their spoken name.',
      'CALL THIS for: "Follow Anna" / "Folge Anna" / "Ich möchte Peter folgen" /',
      '"Follow that member".',
      'Resolves the name to a member; if no match, ask the user to repeat the name.',
      'After success, confirm in one short sentence.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Spoken name (or handle) of the member to follow.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'unfollow_member',
    description: [
      'UNFOLLOW a community member by name. Two-step confirm:',
      'first call returns a confirmation question — ask it, then call again with',
      'confirmed=true after the user says yes.',
      'CALL THIS for: "Unfollow Anna" / "Entfolge Anna" / "Ich will Peter nicht mehr folgen".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Spoken name of the member to unfollow.' },
        confirmed: { type: 'boolean', description: 'true only after the user verbally confirmed.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_notifications',
    description: [
      "READ the user's recent notifications, unread first. Speakable.",
      'CALL THIS for: "Any notifications?" / "Habe ich Benachrichtigungen?" /',
      '"Was gibt es Neues für mich?" / "Read my notifications".',
      'Speak the unread count and the top titles — never deflect to the bell icon.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many to read out, 1-20. Uses 10 when omitted.' },
      },
    },
  },
  {
    name: 'mark_notifications_read',
    description: [
      'MARK notifications as read — all unread ones, or only those whose title',
      'matches a spoken reference.',
      'CALL THIS for: "Mark all as read" / "Alle als gelesen markieren" /',
      '"Clear my notifications" / "Mark the match notification as read".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        reference: {
          type: 'string',
          description: 'Optional words from one notification title to mark only that one. Omit to mark all.',
        },
      },
    },
  },
  {
    name: 'get_wallet_balance',
    description: [
      'READ-ONLY wallet snapshot: balance per currency, active subscription,',
      'last 3 transactions. NEVER moves money — payments happen in the Wallet screen.',
      'CALL THIS for: "What is my wallet balance?" / "Wie viel Guthaben habe ich?" /',
      '"Was ist auf meinem Wallet?" / "My last transactions".',
    ].join('\n'),
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'update_profile',
    description: [
      "UPDATE simple own-profile fields: display_name, bio, city, country, location.",
      'Two-step confirm: first call returns a verbatim read-back — speak it, then',
      'call again with confirmed=true after the user agrees.',
      'CALL THIS for: "Change my bio to …" / "Ändere meinen Namen zu …" /',
      '"Setze meine Stadt auf Berlin".',
      'NEVER use this for role or profile visibility — privacy settings own those.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        display_name: { type: 'string', description: 'New display name.' },
        bio: { type: 'string', description: 'New bio text.' },
        city: { type: 'string', description: 'New city.' },
        country: { type: 'string', description: 'New country.' },
        location: { type: 'string', description: 'New free-text location, e.g. "Berlin, Germany".' },
        confirmed: { type: 'boolean', description: 'true only after the user confirmed the read-back.' },
      },
    },
  },
  {
    name: 'play_podcast',
    description: [
      'PLAY an internal Vitana Media Hub podcast by title or topic. Returns an',
      'open_url directive the app uses to start playback.',
      'CALL THIS for: "Play the longevity podcast" / "Spiel den Vitana Podcast" /',
      '"Play a podcast about sleep".',
      'For music use play_music instead. After success, say what is now playing.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Podcast title or topic. Omit to play the most popular one.' },
      },
    },
  },
  {
    name: 'like_post',
    description: [
      "LIKE a community feed post — resolves \"the last post from <name>\" to that",
      "member's most recent public post.",
      'CALL THIS for: "Like Anna\'s post" / "Like den letzten Beitrag von Anna" /',
      '"Gefällt mir für Peters Post".',
      'After success, confirm which post was liked in one sentence.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        author_name: { type: 'string', description: "Spoken name of the post's author." },
        post_reference: {
          type: 'string',
          description: 'Optional words from the post content to pick a specific post instead of the latest.',
        },
      },
      required: ['author_name'],
    },
  },
  {
    name: 'comment_on_post',
    description: [
      "COMMENT on a community feed post (public text). Two-step confirm:",
      'first call returns the comment for verbatim read-back — speak it, then call',
      'again with confirmed=true after the user says post/yes.',
      'CALL THIS for: "Comment on Anna\'s post: great work" /',
      '"Kommentiere Peters Beitrag mit …".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        author_name: { type: 'string', description: "Spoken name of the post's author." },
        text: { type: 'string', description: 'The comment text to post.' },
        post_reference: {
          type: 'string',
          description: 'Optional words from the post content to pick a specific post instead of the latest.',
        },
        confirmed: { type: 'boolean', description: 'true only after the user confirmed the read-back.' },
      },
      required: ['author_name', 'text'],
    },
  },
];
