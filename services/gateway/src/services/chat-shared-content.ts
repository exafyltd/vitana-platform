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
 * The service-role client is used for two yes/no questions only, never for
 * content: does the item exist at all (so "deleted" can be told apart from
 * "restricted"), and is a profile a test / service account (those are never
 * shown, CLAUDE.md IF–THEN 45).
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

const TABLE: Record<SharedKind, { table: string; key: string }> = {
  post: { table: 'profile_posts', key: 'id' },
  event: { table: 'global_community_events', key: 'id' },
  product: { table: 'products', key: 'id' },
  profile: { table: 'global_community_profiles', key: 'user_id' },
};

type Found = { title: string; description: string; image_url: string | null; url: string } | null;

/** The item as the viewer may see it (user-scoped client), or null when RLS hides it / it is gone. */
async function readAsViewer(userSb: SupabaseClient, ref: SharedRef): Promise<Found> {
  const { table, key } = TABLE[ref.kind];
  if (ref.kind === 'post') {
    const { data, error } = await userSb.from(table).select('id, user_id, content, image_url').eq(key, ref.id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const row = data as { user_id: string; content: string | null; image_url: string | null };
    const { data: author } = await userSb.from('global_community_profiles').select('display_name').eq('user_id', row.user_id).maybeSingle();
    return {
      title: clip((author as { display_name?: string } | null)?.display_name, 80),
      description: clip(row.content),
      image_url: row.image_url ?? null,
      url: `/post/post/${ref.id}`,
    };
  }
  if (ref.kind === 'event') {
    const { data, error } = await userSb.from(table).select('id, title, description, image_url, slug').eq(key, ref.id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const row = data as { title: string | null; description: string | null; image_url: string | null; slug: string | null };
    return {
      title: clip(row.title, 120),
      description: clip(row.description),
      image_url: row.image_url ?? null,
      url: row.slug ? `/e/${row.slug}` : `/pub/events/${ref.id}`,
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
  };
}

/** Does the item exist at all (service role, a yes/no only)? */
async function exists(serviceSb: SupabaseClient, ref: SharedRef): Promise<boolean> {
  const { table, key } = TABLE[ref.kind];
  const { data, error } = await serviceSb.from(table).select(key).eq(key, ref.id).maybeSingle();
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
  if (ref.kind === 'profile') {
    const excluded = await fetchExcludedTestServiceAccountIds(serviceSb);
    if (excluded.has(ref.id)) return { available: false, kind: ref.kind, id: ref.id, reason: 'restricted' };
  }
  const found = await readAsViewer(userSb, ref);
  if (found) return { available: true, kind: ref.kind, id: ref.id, ...found };
  const there = await exists(serviceSb, ref);
  return { available: false, kind: ref.kind, id: ref.id, reason: there ? 'restricted' : 'deleted' };
}

/** May the sender share this item (they can see it themselves)? */
export async function senderCanShare(userSb: SupabaseClient, serviceSb: SupabaseClient, ref: SharedRef): Promise<boolean> {
  const preview = await resolveSharedPreview(userSb, serviceSb, ref);
  return preview.available;
}
