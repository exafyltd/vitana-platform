/**
 * VTID-01942: Vitana Media Hub search/play endpoints.
 *
 * The Media Hub surfaces three in-app content types:
 *   - music  (media_uploads + music_metadata)
 *   - podcast(media_uploads + podcast_metadata)
 *   - shorts (media_videos)
 *
 * This router exposes a minimal search API the `vitana_hub` connector
 * calls from its performAction. Everything stays in Supabase — no
 * external providers.
 *
 * Mounted at /api/v1/media-hub.
 */
import { Router, Request, Response } from 'express';

const router = Router();

async function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(url, key);
}

type MediaType = 'music' | 'podcast' | 'shorts';

interface HubHit {
  id: string;
  type: MediaType;
  title: string;
  description?: string;
  thumbnail_url?: string;
  file_url: string;
  artist?: string;
  host?: string;
  series?: string;
  duration_sec?: number;
}

function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (m) => '\\' + m);
}

/**
 * GET /api/v1/media-hub/search?q=<query>&type=music|podcast|shorts|all&limit=5
 */
router.get('/search', async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim();
  const typeParam = String(req.query.type ?? 'all').toLowerCase();
  const limit = Math.max(1, Math.min(20, Number(req.query.limit ?? 5) || 5));

  if (!q) return res.status(400).json({ ok: false, error: 'q is required' });

  const supabase = await getServiceClient();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Service unavailable' });

  const pattern = `%${escapeLike(q)}%`;
  const hits: HubHit[] = [];

  const wantMusic = typeParam === 'music' || typeParam === 'all';
  const wantPodcast = typeParam === 'podcast' || typeParam === 'all';
  const wantShorts = typeParam === 'shorts' || typeParam === 'all';

  // ── music + podcasts share media_uploads ───────────────────────────────
  if (wantMusic || wantPodcast) {
    const { data: uploads, error } = await supabase
      .from('media_uploads')
      .select('id, title, description, media_type, file_url, thumbnail_url, duration, tags, music_metadata(artist_name), podcast_metadata(host_name, series_name)')
      .eq('status', 'approved')
      .eq('is_public', true)
      .in('media_type', [
        ...(wantMusic ? ['music'] : []),
        ...(wantPodcast ? ['podcast'] : []),
      ])
      .or(`title.ilike.${pattern},description.ilike.${pattern}`)
      .order('plays_count', { ascending: false })
      .limit(limit);

    if (!error && uploads) {
      for (const u of uploads as Array<Record<string, any>>) {
        const type = u.media_type === 'podcast' ? 'podcast' : 'music';
        const music = Array.isArray(u.music_metadata) ? u.music_metadata[0] : u.music_metadata;
        const pod = Array.isArray(u.podcast_metadata) ? u.podcast_metadata[0] : u.podcast_metadata;
        hits.push({
          id: u.id,
          type,
          title: u.title,
          description: u.description ?? undefined,
          thumbnail_url: u.thumbnail_url ?? undefined,
          file_url: u.file_url,
          artist: type === 'music' ? music?.artist_name : undefined,
          host: type === 'podcast' ? pod?.host_name : undefined,
          series: type === 'podcast' ? pod?.series_name : undefined,
          duration_sec: u.duration ?? undefined,
        });
      }
    }
  }

  // ── shorts live in media_videos ────────────────────────────────────────
  if (wantShorts) {
    const { data: videos, error } = await supabase
      .from('media_videos')
      .select('id, title, description, src_url, thumbnail_url, duration_sec, tags')
      .eq('status', 'published')
      .or(`title.ilike.${pattern},description.ilike.${pattern}`)
      .order('views_count', { ascending: false })
      .limit(limit);

    if (!error && videos) {
      for (const v of videos as Array<Record<string, any>>) {
        hits.push({
          id: v.id,
          type: 'shorts',
          title: v.title,
          description: v.description ?? undefined,
          thumbnail_url: v.thumbnail_url ?? undefined,
          file_url: v.src_url,
          duration_sec: v.duration_sec ?? undefined,
        });
      }
    }
  }

  return res.json({ ok: true, query: q, hits: hits.slice(0, limit) });
});

export default router;
