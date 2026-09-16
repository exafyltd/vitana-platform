// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: the
// only test references to "media-hub" are string literals for the
// `/comm/media-hub` frontend route path (nav-redirect-flow.test.ts,
// conversation-flow-v3.test.ts, navigation-catalog.test.ts) and a
// dev-autopilot-planning.test.ts path-string assertion — none exercise
// this module's own DB call sites. Zero genuine coverage today.
/**
 * routes/media-hub.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in this file now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function searchMediaUploads(sb: SupabaseClient, mediaTypes: string[], pattern: string, limit: number) {
  return sb
    .from('media_uploads')
    .select('id, title, description, media_type, file_url, thumbnail_url, duration, tags, music_metadata(artist_name), podcast_metadata(host_name, series_name)')
    .eq('status', 'approved')
    .eq('is_public', true)
    .in('media_type', mediaTypes)
    .or(`title.ilike.${pattern},description.ilike.${pattern}`)
    .order('plays_count', { ascending: false })
    .limit(limit);
}

export async function searchMediaVideos(sb: SupabaseClient, pattern: string, limit: number) {
  return sb
    .from('media_videos')
    .select('id, title, description, src_url, thumbnail_url, duration_sec, tags')
    .eq('status', 'published')
    .or(`title.ilike.${pattern},description.ilike.${pattern}`)
    .order('views_count', { ascending: false })
    .limit(limit);
}

export async function fetchVideoForThumbnailExtraction(sb: SupabaseClient, videoId: string) {
  return sb.from('media_videos').select('id, user_id, src_url').eq('id', videoId).maybeSingle();
}

/** Reused by both the single-video extract-thumbnail route and the
 * admin backfill loop — identical patch shape. */
export async function updateVideoThumbnail(
  sb: SupabaseClient,
  videoId: string,
  extracted: { thumbnail_url: string; duration_sec: number; width: number; height: number },
) {
  return sb
    .from('media_videos')
    .update({
      thumbnail_url: extracted.thumbnail_url,
      duration_sec: extracted.duration_sec,
      width: extracted.width,
      height: extracted.height,
    })
    .eq('id', videoId);
}

export async function fetchVideosMissingThumbnails(sb: SupabaseClient, batchSize: number) {
  return sb
    .from('media_videos')
    .select('id, src_url')
    .is('thumbnail_url', null)
    .not('src_url', 'is', null)
    .limit(batchSize);
}
