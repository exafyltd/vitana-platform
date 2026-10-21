/**
 * VTID-05159 (Health Hub Phase 1 / A2) — raw batches in the encrypted S3
 * bucket (plan Changes 7 and 8).
 *
 * - Key: u/<user_id>/<source_id>/<yyyy>/<mm>/<dd>/<batch_id>.json.gz (UTC date).
 * - Body: gzip(JSON) of the CONSENTED subset of a writeHealthSamples call,
 *   serialised from its input — never the original request bytes, never an
 *   unconsented sample.
 * - Encryption: SSE-KMS (bucket default CMK alias/vitana-health-raw-<env>;
 *   HEALTH_RAW_KMS_KEY_ID pins a key id when set). The bucket is unversioned
 *   and expires objects after 30 days (scripts/aws/setup-health-raw-bucket.sh),
 *   so a delete is final.
 * - Erasure: erasePrefix deletes every object under u/<user_id>/ (account
 *   erasure) or u/<user_id>/<source_id>/ (withdrawal), then lists again and
 *   reports {deleted, residual}.
 *
 * Nothing here throws: every failure is a result with a code.
 */

import { gunzipSync, gzipSync } from 'zlib';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { healthRawBucket, isHealthRawErasureAvailable } from './flags';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RawStoreFailure = { ok: false; code: 'STORE_UNAVAILABLE' | 'INVALID_INPUT' };

export interface RawBatchStore {
  put(key: string, payload: unknown): Promise<{ ok: true } | RawStoreFailure>;
  /** ok:true with payload null when the object does not exist. */
  get(key: string): Promise<{ ok: true; payload: unknown | null } | RawStoreFailure>;
  delete(key: string): Promise<{ ok: true } | RawStoreFailure>;
  erasePrefix(prefix: string): Promise<{ ok: true; deleted: number; residual: number } | RawStoreFailure>;
}

export function rawBatchKey(userId: string, sourceId: string, batchId: string, at: Date): string {
  const yyyy = String(at.getUTCFullYear()).padStart(4, '0');
  const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(at.getUTCDate()).padStart(2, '0');
  return `u/${userId}/${sourceId}/${yyyy}/${mm}/${dd}/${batchId}.json.gz`;
}

/** u/<user>/ or u/<user>/<source>/ — null unless both ids are uuids (never a bucket-wide prefix). */
export function rawBatchPrefix(userId: string, sourceId?: string | null): string | null {
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) return null;
  if (sourceId === undefined || sourceId === null) return `u/${userId}/`;
  if (typeof sourceId !== 'string' || !UUID_RE.test(sourceId)) return null;
  return `u/${userId}/${sourceId}/`;
}

export function encodeRawBatch(payload: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
}

export function decodeRawBatch(body: Uint8Array): unknown {
  return JSON.parse(gunzipSync(Buffer.from(body)).toString('utf8'));
}

/** Minimal S3 surface used here (the real S3Client satisfies it; tests inject a fake). */
export interface S3Like {
  send(command: unknown): Promise<any>;
}

let s3ClientOverride: S3Like | null = null;
let s3Client: S3Like | null = null;

/** Test seam: inject a fake S3 client (null restores the real one). */
export function setHealthRawS3ClientForTests(client: S3Like | null): void {
  s3ClientOverride = client;
}

function client(): S3Like {
  if (s3ClientOverride) return s3ClientOverride;
  if (!s3Client) s3Client = new S3Client({ region: process.env.AWS_REGION || 'eu-central-1' });
  return s3Client;
}

function logFailure(op: string, err: unknown): void {
  const e = err as { name?: unknown; Code?: unknown } | null;
  console.error(
    JSON.stringify({ event: 'health_store_raw_batch_failed', op, code: String(e?.name ?? e?.Code ?? 'unknown') }),
  );
}

async function bodyBytes(body: any): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  if (typeof body.transformToByteArray === 'function') return body.transformToByteArray();
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function s3RawBatchStore(bucket: string): RawBatchStore {
  const kmsKeyId = (process.env.HEALTH_RAW_KMS_KEY_ID ?? '').trim();

  async function listAll(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await client().send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }),
      );
      for (const o of (res?.Contents ?? []) as Array<{ Key?: string }>) if (o.Key) keys.push(o.Key);
      token = res?.IsTruncated ? res?.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  return {
    async put(key, payload) {
      try {
        await client().send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: encodeRawBatch(payload),
            ContentType: 'application/json',
            ContentEncoding: 'gzip',
            ServerSideEncryption: 'aws:kms',
            ...(kmsKeyId ? { SSEKMSKeyId: kmsKeyId } : {}),
          }),
        );
        return { ok: true };
      } catch (err) {
        logFailure('put', err);
        return { ok: false, code: 'STORE_UNAVAILABLE' };
      }
    },
    async get(key) {
      try {
        const res = await client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return { ok: true, payload: decodeRawBatch(await bodyBytes(res?.Body)) };
      } catch (err) {
        const name = (err as { name?: unknown })?.name;
        if (name === 'NoSuchKey' || name === 'NotFound') return { ok: true, payload: null };
        logFailure('get', err);
        return { ok: false, code: 'STORE_UNAVAILABLE' };
      }
    },
    async delete(key) {
      try {
        await client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        return { ok: true };
      } catch (err) {
        logFailure('delete', err);
        return { ok: false, code: 'STORE_UNAVAILABLE' };
      }
    },
    async erasePrefix(prefix) {
      if (!/^u\/[0-9a-f-]{36}\/([0-9a-f-]{36}\/)?$/i.test(prefix)) return { ok: false, code: 'INVALID_INPUT' };
      try {
        const keys = await listAll(prefix);
        let deleted = 0;
        for (let i = 0; i < keys.length; i += 1000) {
          const slice = keys.slice(i, i + 1000);
          const res = await client().send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: slice.map((Key) => ({ Key })), Quiet: true },
            }),
          );
          const errors = ((res?.Errors ?? []) as unknown[]).length;
          deleted += slice.length - errors;
        }
        const residual = (await listAll(prefix)).length;
        return { ok: true, deleted, residual };
      } catch (err) {
        logFailure('erase', err);
        return { ok: false, code: 'STORE_UNAVAILABLE' };
      }
    },
  };
}

/** The configured store, or null when no bucket is configured (and always null on staging). */
export function defaultRawBatchStore(env: NodeJS.ProcessEnv = process.env): RawBatchStore | null {
  const bucket = healthRawBucket(env);
  return bucket && isHealthRawErasureAvailable(env) ? s3RawBatchStore(bucket) : null;
}
