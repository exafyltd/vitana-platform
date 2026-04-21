/**
 * BOOTSTRAP-SHORTS-THUMBNAIL: ffmpeg-based thumbnail extraction for shorts.
 *
 * Downloads a video from the Supabase `media` bucket, runs ffprobe to read
 * dimensions/duration, runs ffmpeg to extract a single JPEG frame, uploads
 * the thumbnail back to the same bucket, and returns a public URL + metadata
 * ready to PATCH onto the media_videos row.
 *
 * Requires `ffmpeg` + `ffprobe` to be present on PATH (installed via the
 * gateway Dockerfile's `apk add --no-cache ffmpeg`).
 */
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface ExtractedVideoMetadata {
  thumbnail_url: string;
  duration_sec: number;
  width: number;
  height: number;
}

export class VideoExtractionError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'VideoExtractionError';
  }
}

interface ProbeResult {
  width: number;
  height: number;
  durationSec: number;
}

function runCommand(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new VideoExtractionError('TIMEOUT', `${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new VideoExtractionError('SPAWN_FAILED', `${cmd} failed to spawn: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

async function probeVideo(filePath: string): Promise<ProbeResult> {
  const { stdout, stderr, code } = await runCommand(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,duration',
      '-show_entries', 'format=duration',
      '-of', 'json',
      filePath,
    ],
    15_000,
  );
  if (code !== 0) {
    throw new VideoExtractionError('PROBE_FAILED', `ffprobe exit ${code}: ${stderr.slice(0, 400)}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new VideoExtractionError('PROBE_PARSE_FAILED', 'ffprobe returned non-JSON output');
  }

  const stream = parsed.streams?.[0];
  if (!stream || !stream.width || !stream.height) {
    throw new VideoExtractionError('NO_VIDEO_STREAM', 'File has no decodable video stream');
  }

  const durationRaw = stream.duration || parsed.format?.duration || '0';
  const durationSec = Math.max(0, Math.floor(parseFloat(String(durationRaw))));

  return {
    width: Number(stream.width),
    height: Number(stream.height),
    durationSec,
  };
}

function thumbnailPathFor(videoPath: string): string {
  return videoPath.replace(/\.[^./]+$/, '.jpg');
}

/**
 * Downloads `videoPath` from the `media` bucket, extracts a thumbnail, uploads
 * it back, and returns the new thumbnail's public URL + video metadata.
 * Caller is responsible for patching media_videos.
 */
export async function extractThumbnail(
  supabase: SupabaseClient,
  videoPath: string,
): Promise<ExtractedVideoMetadata> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'short-thumb-'));
  const videoExt = path.extname(videoPath) || '.mp4';
  const localVideoPath = path.join(workDir, `src${videoExt}`);
  const localThumbPath = path.join(workDir, `${randomUUID()}.jpg`);

  try {
    const { data: blob, error: downloadError } = await supabase.storage
      .from('media')
      .download(videoPath);
    if (downloadError || !blob) {
      throw new VideoExtractionError(
        'DOWNLOAD_FAILED',
        `Supabase storage download failed for ${videoPath}: ${downloadError?.message ?? 'no data'}`,
      );
    }
    const bytes = Buffer.from(await blob.arrayBuffer());
    await fs.writeFile(localVideoPath, bytes);

    const probe = await probeVideo(localVideoPath);

    const seekTime = probe.durationSec > 1 ? '00:00:01' : '00:00:00';
    const ffmpegResult = await runCommand(
      'ffmpeg',
      [
        '-y',
        '-ss', seekTime,
        '-i', localVideoPath,
        '-vframes', '1',
        '-q:v', '3',
        localThumbPath,
      ],
      30_000,
    );
    if (ffmpegResult.code !== 0) {
      throw new VideoExtractionError(
        'FFMPEG_FAILED',
        `ffmpeg exit ${ffmpegResult.code}: ${ffmpegResult.stderr.slice(0, 400)}`,
      );
    }

    const thumbBytes = await fs.readFile(localThumbPath);
    if (thumbBytes.byteLength === 0) {
      throw new VideoExtractionError('EMPTY_THUMBNAIL', 'ffmpeg produced an empty JPEG');
    }

    const remoteThumbPath = thumbnailPathFor(videoPath);
    const { error: uploadError } = await supabase.storage
      .from('media')
      .upload(remoteThumbPath, thumbBytes, {
        contentType: 'image/jpeg',
        upsert: true,
        cacheControl: '3600',
      });
    if (uploadError) {
      throw new VideoExtractionError(
        'UPLOAD_FAILED',
        `Supabase storage upload failed for ${remoteThumbPath}: ${uploadError.message}`,
      );
    }

    const { data: publicUrlData } = supabase.storage.from('media').getPublicUrl(remoteThumbPath);
    if (!publicUrlData?.publicUrl) {
      throw new VideoExtractionError('NO_PUBLIC_URL', 'getPublicUrl returned empty');
    }

    return {
      thumbnail_url: publicUrlData.publicUrl,
      duration_sec: probe.durationSec,
      width: probe.width,
      height: probe.height,
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Extracts the storage path (key within the bucket) from a Supabase public URL.
 * Mirrors the vitana-v1 helper so the gateway can backfill rows whose src_url
 * is a full public URL rather than a raw storage path.
 */
export function extractStoragePath(publicUrl: string, bucket: string): string | null {
  if (!publicUrl) return null;
  const marker = `/storage/v1/object/public/${bucket}/`;
  const idx = publicUrl.indexOf(marker);
  if (idx === -1) return null;
  const raw = publicUrl.slice(idx + marker.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
