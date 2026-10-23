/**
 * VTID-05311 (messenger-ux-v2/api-shared-content, plan I6) — a community post,
 * event, Discover product or member profile shared into a chat.
 *
 * The message stores only `{ kind, id }` (metadata). Nothing of the item is
 * copied: every viewer resolves the card with THEIR OWN permissions — the
 * user-scoped Supabase client (anon key + the viewer's JWT, lib/supabase-user),
 * so RLS decides what each person may see. The sender's own permissions are
 * checked the same way before the message is stored.
 *
 * The service-role client is used for yes/no questions only, never for
 * content: does the item exist at all (so "deleted" can be told apart from
 * "restricted" — not for profiles, whose ids are user ids: every unreadable
 * profile is "restricted"), and is the profile / the post's author / the
 * event's creator a test or service account (never shown, CLAUDE.md 43/45).
 * Posts are shown only while `moderation_status = 'active'` (hidden / removed
 * posts and banned authors' posts are what the feed hides too).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchExcludedTestServiceAccountIds } from '../lib/excluded-test-service-accounts';

export const SHARED_CONTENT_TYPE = 'shared_content';
export const SHARED_KINDS = ['post', 'event', 'product', 'profile'] as const;
export type SharedKind = (typeof SHARED_KINDS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DESCRIPTION_MAX = 200;

export interface SharedRef { kind: SharedKind; id: string }

export type SharedPreview =
  | { available: true; kind: SharedKind; id: string; title: string; description: string; image_url: string | null; url: string }
  | { available: false; kind: SharedKind; id: string; reason: 'deleted' | 'restricted' };

/** `{ kind, id }` from client input, or null. Profiles are keyed by the member's user id. */
export function parseSharedRef(input: unknown): SharedRef | null {
  if (!input || typeof input !== 'object') return null;
  const { kind, id } = input as { kind?: unknown; id?: unknown };
  if (typeof kind !== 'string' || !(SHARED_KINDS as readonly string[]).includes(kind)) return null;
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
  return { kind: kind as SharedKind, id: id.toLowerCase() };
}

function clip(text: unknown, max = DESCRIPTION_MAX): string {
  const s = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A shared message's caption (optional text next to the card). */
export const SHARED_CAPTION_MAX = 1000;

const TABLE: Record<SharedKind, { table: string; key: string }> = {
  post: { table: 'profile_posts', key: 'id' },
  event: { table: 'global_community_events', key: 'id' },
  product: { table: 'products', key: 'id' },
  profile: { table: 'global_community_profiles', key: 'user_id' },
};

type Found = { title: string; description: string; image_url: string | null; url: string; owner: string | null } | null;

/** The item as the viewer may see it (user-scoped client), or null when RLS hides it / it is gone. */
async function readAsViewer(userSb: SupabaseClient, ref: SharedRef): Promise<Found> {
  const { table, key } = TABLE[ref.kind];
  if (ref.kind === 'post') {
    const { data, error } = await userSb.from(table).select('id, user_id, content, image_url')
      .eq(key, ref.id).eq('moderation_status', 'active').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const row = data as { user_id: string; content: string | null; image_url: string | null };
    // The author's name as the viewer may see it (a hidden profile → no name).
    const { data: author, error: authorError } = await userSb.from('global_community_profiles').select('display_name').eq('user_id', row.user_id).maybeSingle();
    if (authorError) throw new Error(authorError.message);
    return {
      title: clip((author as { display_name?: string } | null)?.display_name, 80),
      description: clip(row.content),
      image_url: row.image_url ?? null,
      url: `/post/post/${ref.id}`,
      owner: row.user_id,
    };
  }
  if (ref.kind === 'event') {
    const { data, error } = await userSb.from(table).select('id, title, description, image_url, slug, created_by').eq(key, ref.id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const row = data as { title: string | null; description: string | null; image_url: string | null; slug: string | null; created_by: string | null };
    return {
      title: clip(row.title, 120),
      description: clip(row.description),
      image_url: row.image_url ?? null,
      url: row.slug ? `/e/${row.slug}` : `/pub/events/${ref.id}`,
      owner: row.created_by ?? null,
    };
  }
  if (ref.kind === 'product') {
    const { data, error } = await userSb.from(table).select('id, title, description, images').eq(key, ref.id).eq('is_active', true).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const row = data as { title: string | null; description: string | null; images: string[] | null };
    return {
      title: clip(row.title, 120),
      description: clip(row.description),
      image_url: Array.isArray(row.images) && row.images.length > 0 ? row.images[0] : null,
      url: `/discover/product/${ref.id}`,
      owner: null,
    };
  }
  const { data, error } = await userSb.from(table).select('user_id, display_name, bio, avatar_url').eq(key, ref.id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as { display_name: string | null; bio: string | null; avatar_url: string | null };
  return {
    title: clip(row.display_name, 80),
    description: clip(row.bio),
    image_url: row.avatar_url ?? null,
    url: `/u/${ref.id}`,
    owner: ref.id,
  };
}

/** Does the item exist at all (service role, a yes/no only)? */
async function exists(serviceSb: SupabaseClient, ref: SharedRef): Promise<boolean> {
  const { table, key } = TABLE[ref.kind];
  let q = serviceSb.from(table).select(key).eq(key, ref.id);
  // A delisted product is gone for members (deleted), not access-restricted.
  if (ref.kind === 'product') q = q.eq('is_active', true);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(error.message);
  return !!data;
}

/**
 * The card for one viewer. A profile of a test / service account is always
 * `restricted`. Errors propagate (the route answers 503); a viewer is never
 * shown content they could not read themselves.
 */
export async function resolveSharedPreview(
  userSb: SupabaseClient,
  serviceSb: SupabaseClient,
  ref: SharedRef,
): Promise<SharedPreview> {
  const restricted: SharedPreview = { available: false, kind: ref.kind, id: ref.id, reason: 'restricted' };
  const found = await readAsViewer(userSb, ref);
  if (found) {
    if (found.owner) {
      const excluded = await fetchExcludedTestServiceAccountIds(serviceSb);
      if (excluded.has(found.owner)) return restricted;
    }
    const { owner: _owner, ...card } = found;
    return { available: true, kind: ref.kind, id: ref.id, ...card };
  }
  // Profile ids are user ids: never reveal whether a member has a hidden profile.
  if (ref.kind === 'profile') return restricted;
  const there = await exists(serviceSb, ref);
  return there ? restricted : { available: false, kind: ref.kind, id: ref.id, reason: 'deleted' };
}

/** May the sender share this item (they can see it themselves)? */
export async function senderCanShare(userSb: SupabaseClient, serviceSb: SupabaseClient, ref: SharedRef): Promise<boolean> {
  const preview = await resolveSharedPreview(userSb, serviceSb, ref);
  return preview.available;
}
