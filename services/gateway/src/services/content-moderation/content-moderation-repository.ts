/**
 * routes/tenant-admin/content-moderation.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/tenant-admin/content-
 * moderation.ts (all against media_uploads, its related *_metadata
 * embeds included) now goes through here instead of being written
 * inline. PURE MOVE, not a rewrite: same queries, same columns, same
 * `{ data, error }` shapes — no behavior change today.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface MediaItemsFilters {
  status?: string;
  mediaType?: string;
  limit: number;
}

export async function fetchMediaItems(supabase: SupabaseClient, f: MediaItemsFilters) {
  let query = supabase.from('media_uploads').select('*').order('created_at', { ascending: false }).limit(f.limit);
  if (f.status) query = query.eq('status', f.status);
  if (f.mediaType) query = query.eq('media_type', f.mediaType);
  return query;
}

export async function fetchMediaItemsStats(supabase: SupabaseClient) {
  return supabase.from('media_uploads').select('status, media_type');
}

export async function fetchMediaItemById(supabase: SupabaseClient, id: string) {
  return supabase.from('media_uploads').select('*, music_metadata(*), podcast_metadata(*), video_metadata(*)').eq('id', id).single();
}

export async function updateMediaItem(supabase: SupabaseClient, id: string, fields: Record<string, unknown>) {
  return supabase.from('media_uploads').update(fields).eq('id', id).select('*').single();
}
