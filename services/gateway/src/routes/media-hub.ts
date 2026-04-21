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
import { z } from 'zod';
import { requireAuth, requireAdminAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import {
  analyzeShortFrames,
  VisionClientError,
} from '../services/anthropic-vision-client';
import {
  extractThumbnail,
  extractStoragePath,
  VideoExtractionError,
} from '../services/video-thumbnail-service';

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

// ── POST /shorts/auto-metadata ───────────────────────────────────────────
// Auto-generate title, description, category, and tags from 3 keyframes of a
// short video. Powered by Claude Sonnet 4.6 (vision + forced tool use). See
// services/anthropic-vision-client.ts for the prompt and sanitization pipeline.

const KeyframeSchema = z.object({
  position_ratio: z.number().min(0).max(1),
  data_url: z
    .string()
    .startsWith('data:image/jpeg;base64,')
    .max(400_000),
});

const AutoMetadataRequestSchema = z.object({
  filename: z.string().min(1).max(255),
  duration_seconds: z.number().positive().max(600),
  mime_type: z.string().regex(/^video\//).max(64),
  frames: z.array(KeyframeSchema).min(1).max(5),
});

router.post('/shorts/auto-metadata', requireAuth, async (req: Request, res: Response) => {
  const validation = AutoMetadataRequestSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid request body',
      details: validation.error.issues,
    });
  }

  try {
    const result = await analyzeShortFrames({
      frames: validation.data.frames,
      filename: validation.data.filename,
      durationSeconds: validation.data.duration_seconds,
    });

    return res.json({
      ok: true,
      metadata: {
        title: result.title,
        description: result.description,
        category: result.category,
        tags: result.tags,
      },
      model: result.model,
      latency_ms: result.latencyMs,
    });
  } catch (err) {
    if (err instanceof VisionClientError) {
      const status =
        err.code === 'TIMEOUT'
          ? 504
          : err.code === 'RATE_LIMIT'
          ? 429
          : err.code === 'MISSING_API_KEY'
          ? 503
          : 502;
      return res.status(status).json({
        ok: false,
        error: 'Auto-metadata generation failed',
        code: err.code,
        details: err.message,
      });
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[media-hub] POST /shorts/auto-metadata error: ${message}`);
    return res.status(500).json({
      ok: false,
      error: 'Auto-metadata generation failed',
      code: 'INTERNAL',
      details: message,
    });
  }
});

// ── POST /shorts/extract-thumbnail ───────────────────────────────────────
// Single-video thumbnail extraction. Called by vitana-v1's upload hook right
// after the media_videos row is inserted. The caller must own the row.

const ExtractThumbnailRequestSchema = z.object({
  video_id: z.string().uuid(),
  video_path: z.string().min(1).max(512),
});

function mapExtractionError(err: unknown): { status: number; code: string; message: string } {
  if (err instanceof VideoExtractionError) {
    const status = err.code === 'TIMEOUT' ? 504 : err.code === 'NO_VIDEO_STREAM' ? 422 : 500;
    return { status, code: err.code, message: err.message };
  }
  const message = err instanceof Error ? err.message : 'Unknown error';
  return { status: 500, code: 'INTERNAL', message };
}

router.post('/shorts/extract-thumbnail', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const validation = ExtractThumbnailRequestSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid request body',
      details: validation.error.issues,
    });
  }
  const { video_id, video_path } = validation.data;
  const userId = req.identity?.user_id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const supabase = await getServiceClient();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Service unavailable' });

  const { data: row, error: fetchError } = await supabase
    .from('media_videos')
    .select('id, user_id, src_url')
    .eq('id', video_id)
    .maybeSingle();
  if (fetchError) {
    console.error(`[media-hub] POST /shorts/extract-thumbnail fetch error: ${fetchError.message}`);
    return res.status(500).json({ ok: false, error: 'Database error', code: 'DB_FETCH_FAILED' });
  }
  if (!row) {
    return res.status(404).json({ ok: false, error: 'Video not found', code: 'NOT_FOUND' });
  }
  if (row.user_id !== userId) {
    return res.status(403).json({ ok: false, error: 'Not the video owner', code: 'FORBIDDEN' });
  }

  const started = Date.now();
  try {
    const extracted = await extractThumbnail(supabase, video_path);
    const { error: patchError } = await supabase
      .from('media_videos')
      .update({
        thumbnail_url: extracted.thumbnail_url,
        duration_sec: extracted.duration_sec,
        width: extracted.width,
        height: extracted.height,
      })
      .eq('id', video_id);
    if (patchError) {
      console.error(`[media-hub] POST /shorts/extract-thumbnail patch error: ${patchError.message}`);
      return res.status(500).json({ ok: false, error: 'Database error', code: 'DB_PATCH_FAILED' });
    }

    console.log(
      `[media-hub] thumbnail extracted video_id=${video_id} user=${userId} latency_ms=${Date.now() - started}`,
    );
    return res.json({
      ok: true,
      thumbnail_url: extracted.thumbnail_url,
      duration_sec: extracted.duration_sec,
      width: extracted.width,
      height: extracted.height,
      latency_ms: Date.now() - started,
    });
  } catch (err) {
    const mapped = mapExtractionError(err);
    console.error(
      `[media-hub] POST /shorts/extract-thumbnail failed video_id=${video_id} code=${mapped.code}: ${mapped.message}`,
    );
    return res.status(mapped.status).json({
      ok: false,
      error: 'Thumbnail extraction failed',
      code: mapped.code,
      details: mapped.message,
    });
  }
});

// ── POST /admin/backfill-video-thumbnails ────────────────────────────────
// One-shot backfill for rows that landed with thumbnail_url=null. Admin only,
// synchronous, paged at batch_size per call so a single invocation can't
// exhaust the Cloud Run request window. Re-call until processed=0.

const BackfillRequestSchema = z.object({
  batch_size: z.number().int().min(1).max(25).optional(),
});

router.post(
  '/admin/backfill-video-thumbnails',
  requireAdminAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const validation = BackfillRequestSchema.safeParse(req.body ?? {});
    if (!validation.success) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid request body',
        details: validation.error.issues,
      });
    }
    const batchSize = validation.data.batch_size ?? 10;

    const supabase = await getServiceClient();
    if (!supabase) return res.status(503).json({ ok: false, error: 'Service unavailable' });

    const { data: rows, error: listError } = await supabase
      .from('media_videos')
      .select('id, src_url')
      .is('thumbnail_url', null)
      .not('src_url', 'is', null)
      .limit(batchSize);
    if (listError) {
      return res.status(500).json({ ok: false, error: 'Database error', code: 'DB_LIST_FAILED', details: listError.message });
    }
    if (!rows || rows.length === 0) {
      return res.json({ ok: true, processed: 0, succeeded: 0, failed: 0, errors: [] });
    }

    let succeeded = 0;
    const errors: Array<{ id: string; code: string; message: string }> = [];
    for (const row of rows) {
      const videoPath = extractStoragePath(row.src_url as string, 'media') ?? row.src_url;
      if (!videoPath) {
        errors.push({ id: row.id as string, code: 'BAD_SRC_URL', message: 'Cannot derive storage path' });
        continue;
      }
      try {
        const extracted = await extractThumbnail(supabase, videoPath);
        const { error: patchError } = await supabase
          .from('media_videos')
          .update({
            thumbnail_url: extracted.thumbnail_url,
            duration_sec: extracted.duration_sec,
            width: extracted.width,
            height: extracted.height,
          })
          .eq('id', row.id);
        if (patchError) {
          errors.push({ id: row.id as string, code: 'DB_PATCH_FAILED', message: patchError.message });
          continue;
        }
        succeeded += 1;
      } catch (err) {
        const mapped = mapExtractionError(err);
        errors.push({ id: row.id as string, code: mapped.code, message: mapped.message });
      }
    }

    return res.json({
      ok: true,
      processed: rows.length,
      succeeded,
      failed: rows.length - succeeded,
      errors,
    });
  },
);

export default router;
