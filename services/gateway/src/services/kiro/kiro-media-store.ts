/**
 * VTID-05070: where Kiro's staging screenshots are kept.
 *
 * Private bucket `operator-media` (the bucket the Operator's pasted images use, VTID-05065
 * family Phase 2 — created once through the Storage API by its setup script, never by an
 * INSERT into storage.buckets), objects at `kiro/<user_id>/<thread_id>/<uuid>.png`. Gateway
 * service role only; the console gets 1 h signed URLs. Goes through the platform's storage
 * provider (services/storage/storage-provider.ts), so the S3 switch covers it too.
 *
 * Small on purpose: when Phase 2's shared media helper lands, this file becomes a thin
 * caller of it (same bucket, same path scheme).
 */
import { randomUUID } from 'crypto';
import { storageSignedUrl, storageUpload } from '../storage/storage-provider';

export const OPERATOR_MEDIA_BUCKET = 'operator-media';
export const KIRO_MEDIA_MAX_BYTES = 5 * 1024 * 1024;
export const KIRO_MEDIA_URL_TTL_S = 3600;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE = /^[A-Za-z0-9_-]{1,200}$/;

/** PNG magic bytes (the name or content-type alone is never trusted). */
export function isPng(buf: Buffer): boolean {
  return buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a && buf.toString('ascii', 12, 16) === 'IHDR';
}

export function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  return isPng(buf) ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null;
}

/** The object path of one screenshot; null when an id is not path-safe. */
export function kiroMediaPath(userId: string, threadId: string, mediaId: string): string | null {
  if (!SAFE.test(userId) || !SAFE.test(threadId) || !UUID.test(mediaId)) return null;
  return `kiro/${userId}/${threadId}/${mediaId.toLowerCase()}.png`;
}

export interface KiroMediaStore {
  put(path: string, png: Buffer): Promise<{ error: Error | null }>;
  sign(path: string, ttlSeconds: number): Promise<{ url: string | null; error: Error | null }>;
}

const providerStore: KiroMediaStore = {
  put: (path, png) => storageUpload(OPERATOR_MEDIA_BUCKET, path, png, { contentType: 'image/png', upsert: false, cacheControl: '3600' }),
  sign: (path, ttl) => storageSignedUrl(OPERATOR_MEDIA_BUCKET, path, ttl),
};

let store: KiroMediaStore = providerStore;
/** Tests only. */
export function setKiroMediaStore(s: KiroMediaStore | null): void { store = s ?? providerStore; }

export async function putKiroScreenshot(userId: string, threadId: string, png: Buffer): Promise<{ ok: true; mediaId: string; path: string } | { ok: false; error: string }> {
  const mediaId = randomUUID();
  const path = kiroMediaPath(userId, threadId, mediaId);
  if (!path) return { ok: false, error: 'invalid_ids' };
  const r = await store.put(path, png);
  return r.error ? { ok: false, error: r.error.message.slice(0, 200) } : { ok: true, mediaId, path };
}

export async function signKiroMedia(path: string, ttlSeconds = KIRO_MEDIA_URL_TTL_S): Promise<string | null> {
  const r = await store.sign(path, ttlSeconds).catch(() => ({ url: null, error: null }));
  return r.url;
}
