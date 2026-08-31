/**
 * VTID-03765 — Object storage provider selection (Aurora/AWS migration, B6).
 *
 * Single place that decides whether a storage operation goes to Supabase
 * Storage (canonical today) or Amazon S3 — same shape as `TTS_PROVIDER`
 * (tts-provider.ts, §2c) and `IMAGE_PROVIDER` (titan-image.ts, §2d).
 *
 * ## Default is `supabase`. Deploying this code flips nothing.
 *
 * `STORAGE_PROVIDER=s3` is a deliberate, separate operator action, taken
 * only once scripts/aws/setup-storage-buckets.sh has provisioned the S3
 * buckets AND the object data has actually been copied over (see
 * scripts/aws/migrate-storage-to-s3.sh) — flipping this before the copy is
 * done would make every existing file 404.
 *
 * Unlike TTS/Titan, there is deliberately **no per-request fallback**
 * between providers here: object storage is either fully on S3 or fully on
 * Supabase for a given deploy, never mixed per-call. A half-migrated bucket
 * with some objects on each side is a state to avoid, not paper over with a
 * silent fallback (CLAUDE.md: "Never allow silent model fallback" — the same
 * principle applies to storage backends, not just LLM providers).
 */

import { getSupabase } from '../../lib/supabase';
import { s3Download, s3Upload, s3Remove, s3PublicUrl } from '../../providers/s3-storage';

export type StorageProviderName = 'supabase' | 's3';

export function getStorageProvider(): StorageProviderName {
  const raw = (process.env.STORAGE_PROVIDER || 'supabase').trim().toLowerCase();
  if (raw === 's3') return 's3';
  if (raw !== 'supabase' && raw !== '') {
    console.warn(`[Storage] Unrecognised STORAGE_PROVIDER='${raw}' — defaulting to 'supabase'.`);
  }
  return 'supabase';
}

export async function storageDownload(bucket: string, path: string): Promise<{ data: Buffer | null; error: Error | null }> {
  if (getStorageProvider() === 's3') return s3Download(bucket, path);
  const supabase = getSupabase();
  if (!supabase) return { data: null, error: new Error('Supabase client unavailable') };
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) return { data: null, error: error ? new Error(error.message) : new Error('download returned no data') };
  const bytes = Buffer.from(await data.arrayBuffer());
  return { data: bytes, error: null };
}

export async function storageUpload(
  bucket: string,
  path: string,
  bytes: Buffer | Uint8Array,
  opts: { contentType?: string; upsert?: boolean; cacheControl?: string } = {},
): Promise<{ error: Error | null }> {
  if (getStorageProvider() === 's3') {
    return s3Upload(bucket, path, bytes, { contentType: opts.contentType, cacheControl: opts.cacheControl });
  }
  const supabase = getSupabase();
  if (!supabase) return { error: new Error('Supabase client unavailable') };
  const { error } = await supabase.storage.from(bucket).upload(path, bytes, {
    contentType: opts.contentType,
    upsert: opts.upsert ?? false,
    cacheControl: opts.cacheControl,
  });
  return { error: error ? new Error(error.message) : null };
}

export async function storageRemove(bucket: string, paths: string[]): Promise<{ error: Error | null }> {
  if (getStorageProvider() === 's3') return s3Remove(bucket, paths);
  const supabase = getSupabase();
  if (!supabase) return { error: new Error('Supabase client unavailable') };
  const { error } = await supabase.storage.from(bucket).remove(paths);
  return { error: error ? new Error(error.message) : null };
}

export function storagePublicUrl(bucket: string, path: string): string {
  if (getStorageProvider() === 's3') return s3PublicUrl(bucket, path);
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase client unavailable');
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}
