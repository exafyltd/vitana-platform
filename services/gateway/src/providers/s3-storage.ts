/**
 * VTID-03765 — Amazon S3 object storage provider (Aurora/AWS migration, B6).
 *
 * Mirrors the exact 4-operation surface the gateway's Supabase Storage call
 * sites actually use (confirmed via a full grep sweep across
 * video-thumbnail-service.ts, intent-cover-service.ts, cover-image-
 * outpaint.ts — see docs/AURORA-B6-STORAGE-INVENTORY.md): download, upload,
 * remove, and public-URL construction. Nothing else — this is not a general
 * S3 SDK wrapper.
 *
 * Bucket naming: Supabase bucket `<name>` maps to S3 bucket
 * `vitana-storage-<name>` (see scripts/aws/setup-storage-buckets.sh, which
 * provisions all 19 buckets with the same public/private split the
 * B6 inventory found live on Supabase).
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';

const REGION = process.env.AWS_S3_STORAGE_REGION || process.env.AWS_REGION || 'eu-central-1';
let client: S3Client | null = null;

function getClient(): S3Client {
  if (!client) client = new S3Client({ region: REGION });
  return client;
}

export function s3BucketName(supabaseBucket: string): string {
  return `vitana-storage-${supabaseBucket}`;
}

export async function s3Download(bucket: string, path: string): Promise<{ data: Buffer | null; error: Error | null }> {
  try {
    const out = await getClient().send(new GetObjectCommand({ Bucket: s3BucketName(bucket), Key: path }));
    const bytes = await out.Body?.transformToByteArray();
    return { data: bytes ? Buffer.from(bytes) : null, error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

export async function s3Upload(
  bucket: string,
  path: string,
  bytes: Buffer | Uint8Array,
  opts: { contentType?: string; cacheControl?: string } = {},
): Promise<{ error: Error | null }> {
  try {
    await getClient().send(new PutObjectCommand({
      Bucket: s3BucketName(bucket),
      Key: path,
      Body: bytes,
      ContentType: opts.contentType,
      CacheControl: opts.cacheControl,
    }));
    return { error: null };
  } catch (err) {
    return { error: err instanceof Error ? err : new Error(String(err)) };
  }
}

export async function s3Remove(bucket: string, paths: string[]): Promise<{ error: Error | null }> {
  if (paths.length === 0) return { error: null };
  try {
    await getClient().send(new DeleteObjectsCommand({
      Bucket: s3BucketName(bucket),
      Delete: { Objects: paths.map((Key) => ({ Key })) },
    }));
    return { error: null };
  } catch (err) {
    return { error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/**
 * Public URL for a public bucket. Callers must not call this for a private
 * bucket expecting it to be access-controlled — S3 URLs are only gated by
 * the bucket policy set at provisioning time (see setup-storage-buckets.sh),
 * mirroring how Supabase's own `getPublicUrl()` behaves identically (a
 * plain URL string with no signing, regardless of the bucket's real ACL).
 */
export function s3PublicUrl(bucket: string, path: string): string {
  const s3bucket = s3BucketName(bucket);
  return `https://${s3bucket}.s3.${REGION}.amazonaws.com/${path}`;
}
