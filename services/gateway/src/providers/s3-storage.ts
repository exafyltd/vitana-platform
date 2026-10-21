/**
 * VTID-03765 — Amazon S3 object storage provider (Aurora/AWS migration, B6).
 *
 * Originally mirrored the exact 4-operation surface the gateway's own
 * Supabase Storage call sites used (download, upload, remove, public-URL —
 * confirmed via a grep sweep across video-thumbnail-service.ts,
 * intent-cover-service.ts, cover-image-outpaint.ts). `s3List` (VTID-03815,
 * B6 edge-function gap addendum) added a fifth, for the gateway-owned
 * storage-bridge route's `request-account-deletion` (vitana-v1) consumer,
 * which needs to enumerate a user's files before deleting them. `s3SignedUrl`
 * (same VTID, same addendum's follow-up) is the sixth — a presigned GET URL
 * unlocks two more edge functions the storage-bridge route originally left
 * unsolved: `voucher-download-pdf` needs a signed link to hand the user, and
 * `extract-video-meta` can fetch its source video directly from a signed URL
 * instead of proxying the bytes through the gateway's 2mb JSON body limit —
 * still not a general S3 SDK wrapper, just the specific ops real callers need.
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
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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
 * Lists object keys directly under `prefix` (which callers pass as
 * e.g. `"<userId>/"`), returning `name`s relative to that prefix — matching
 * Supabase Storage's `.list()` shape exactly (`{name: string}[]`) so
 * `storage-provider.ts`'s `storageList` can hand back the identical shape
 * regardless of which backend answered. S3 has no folder concept — this
 * uses `Delimiter: '/'` so a nested "subfolder" isn't silently flattened
 * into the same listing (Supabase's own `.list()` is also non-recursive by
 * default, so this preserves that behavior rather than changing it).
 */
export async function s3List(
  bucket: string,
  prefix: string,
  limit = 1000,
): Promise<{ data: { name: string }[] | null; error: Error | null }> {
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  try {
    const out = await getClient().send(new ListObjectsV2Command({
      Bucket: s3BucketName(bucket),
      Prefix: normalizedPrefix,
      Delimiter: '/',
      MaxKeys: limit,
    }));
    const names = (out.Contents ?? [])
      .map((obj) => obj.Key ?? '')
      .filter((key) => key.length > normalizedPrefix.length)
      .map((key) => key.slice(normalizedPrefix.length));
    return { data: names.map((name) => ({ name })), error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/**
 * A time-limited, pre-signed GET URL — works for both public and private
 * buckets (unlike `s3PublicUrl`, which is only meaningful for a public
 * bucket's policy). Mirrors Supabase Storage's `.createSignedUrl()` return
 * shape (`{url, error}` rather than `{data, error}` — no other caller here
 * needs a `data` wrapper around a single string).
 */
export async function s3SignedUrl(
  bucket: string,
  path: string,
  expiresInSeconds: number,
): Promise<{ url: string | null; error: Error | null }> {
  try {
    const url = await getSignedUrl(
      getClient(),
      new GetObjectCommand({ Bucket: s3BucketName(bucket), Key: path }),
      { expiresIn: expiresInSeconds },
    );
    return { url, error: null };
  } catch (err) {
    return { url: null, error: err instanceof Error ? err : new Error(String(err)) };
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
