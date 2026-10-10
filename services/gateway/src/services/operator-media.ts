/**
 * VTID-05067: images pasted, dropped or picked into the Command Hub Operator Console.
 *
 * Stored in the PRIVATE Supabase Storage bucket `operator-media` (created once by
 * scripts/supabase/setup-operator-media-bucket.mjs through the Storage API; no
 * client policies — only this gateway, with the service role, reads or writes it),
 * at `<user_id>/<thread_id>/<uuid>.<ext>`. One row per image in `operator_media`
 * (owner, thread, object path, type, size) so the gateway can check the owner and
 * re-sign without listing the bucket.
 *
 * Only png / jpeg / webp / gif, recognised by their magic bytes (never by the name
 * or the declared Content-Type alone), at most 5 MB each, at most 4 per message
 * (checked where a run or a chat turn starts). A browser only ever gets a 1-hour
 * signed URL, minted per view; URLs are never stored.
 *
 * Admin-only Operator Console data.
 */
import { randomUUID } from 'crypto';
import { getSupabasePublicUrl } from '../lib/supabase-public-url';

const LOG = '[VTID-05067]';

export const OPERATOR_MEDIA_BUCKET = 'operator-media';
export const OPERATOR_MEDIA_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxPerMessage: 4,
  signedUrlTtlSeconds: 3600,
};

export const OPERATOR_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type OperatorMediaType = (typeof OPERATOR_MEDIA_TYPES)[number];
const EXT: Record<OperatorMediaType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** The image type the bytes really are (magic bytes), or null for anything else. */
export function sniffImageType(buf: Buffer): OperatorMediaType | null {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export interface OperatorMediaRow {
  id: string;
  user_id: string;
  thread_id: string;
  object_path: string;
  mime_type: OperatorMediaType;
  size_bytes: number;
  created_at: string;
}

export interface OperatorMediaAttachment { media_id: string; mime_type: string }

function supa(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  return url && key ? { url: url.replace(/\/+$/, ''), key } : null;
}

const enc = encodeURIComponent;
const encPath = (p: string) => p.split('/').map(enc).join('/');

export type StoreMediaResult =
  | { ok: true; media: OperatorMediaRow; oasis_ref: string; url: string | null }
  | { ok: false; status: number; error: 'empty' | 'too_large' | 'unsupported_type' | 'type_mismatch' | 'storage_unavailable' | 'store_failed' };

/**
 * Validate and store one image. `declaredType` is the request's Content-Type; it must be
 * one of the four types AND match what the bytes are.
 */
export async function storeOperatorMedia(input: { userId: string; threadId: string; bytes: Buffer; declaredType: string }): Promise<StoreMediaResult> {
  const { bytes } = input;
  if (!bytes || bytes.length === 0) return { ok: false, status: 400, error: 'empty' };
  if (bytes.length > OPERATOR_MEDIA_LIMITS.maxBytes) return { ok: false, status: 413, error: 'too_large' };
  const declared = String(input.declaredType || '').split(';')[0].trim().toLowerCase();
  if (!(OPERATOR_MEDIA_TYPES as readonly string[]).includes(declared)) return { ok: false, status: 415, error: 'unsupported_type' };
  const real = sniffImageType(bytes);
  if (!real) return { ok: false, status: 415, error: 'unsupported_type' };
  if (real !== declared) return { ok: false, status: 415, error: 'type_mismatch' };
  const s = supa();
  if (!s) return { ok: false, status: 503, error: 'storage_unavailable' };

  const id = randomUUID();
  const objectPath = `${input.userId}/${input.threadId}/${id}.${EXT[real]}`;
  try {
    const up = await fetch(`${s.url}/storage/v1/object/${OPERATOR_MEDIA_BUCKET}/${encPath(objectPath)}`, {
      method: 'POST',
      headers: { apikey: s.key, Authorization: `Bearer ${s.key}`, 'Content-Type': real, 'x-upsert': 'false', 'Cache-Control': 'private, max-age=3600' },
      body: bytes,
    });
    if (!up.ok) {
      console.error(`${LOG} storage upload failed (${up.status}): ${(await up.text().catch(() => '')).slice(0, 200)}`);
      return { ok: false, status: 503, error: 'storage_unavailable' };
    }
  } catch (err) {
    console.error(`${LOG} storage upload threw:`, err instanceof Error ? err.message : err);
    return { ok: false, status: 503, error: 'storage_unavailable' };
  }

  const row: OperatorMediaRow = {
    id, user_id: input.userId, thread_id: input.threadId, object_path: objectPath,
    mime_type: real, size_bytes: bytes.length, created_at: new Date().toISOString(),
  };
  try {
    const ins = await fetch(`${s.url}/rest/v1/operator_media`, {
      method: 'POST',
      headers: { apikey: s.key, Authorization: `Bearer ${s.key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(row),
    });
    if (!ins.ok) {
      console.error(`${LOG} operator_media insert failed (${ins.status}): ${(await ins.text().catch(() => '')).slice(0, 200)}`);
      return { ok: false, status: 503, error: 'store_failed' };
    }
  } catch (err) {
    console.error(`${LOG} operator_media insert threw:`, err instanceof Error ? err.message : err);
    return { ok: false, status: 503, error: 'store_failed' };
  }
  return { ok: true, media: row, oasis_ref: operatorMediaOasisRef(id), url: await signOperatorMedia(objectPath) };
}

export function operatorMediaOasisRef(id: string): string {
  return `OASIS-MEDIA-${id.slice(0, 8).toUpperCase()}`;
}

export async function getOperatorMedia(id: string): Promise<OperatorMediaRow | null> {
  const s = supa();
  if (!s) return null;
  try {
    const r = await fetch(`${s.url}/rest/v1/operator_media?id=eq.${enc(id)}&select=id,user_id,thread_id,object_path,mime_type,size_bytes,created_at&limit=1`, {
      headers: { apikey: s.key, Authorization: `Bearer ${s.key}` },
    });
    if (!r.ok) return null;
    const rows = (await r.json()) as OperatorMediaRow[];
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch {
    return null;
  }
}

/** A 1-hour signed URL for the object, on the PUBLIC Supabase origin; null when signing fails. */
export async function signOperatorMedia(objectPath: string, ttlSeconds: number = OPERATOR_MEDIA_LIMITS.signedUrlTtlSeconds): Promise<string | null> {
  const s = supa();
  if (!s) return null;
  try {
    const r = await fetch(`${s.url}/storage/v1/object/sign/${OPERATOR_MEDIA_BUCKET}/${encPath(objectPath)}`, {
      method: 'POST',
      headers: { apikey: s.key, Authorization: `Bearer ${s.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: ttlSeconds }),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { signedURL?: string; signedUrl?: string };
    const rel = body.signedURL ?? body.signedUrl;
    if (!rel) return null;
    const base = getSupabasePublicUrl() ?? s.url;
    return /^https?:\/\//.test(rel) ? rel : `${base}/storage/v1${rel.startsWith('/') ? rel : `/${rel}`}`;
  } catch {
    return null;
  }
}

export type LoadMediaResult =
  | { ok: true; media: OperatorMediaRow[] }
  | { ok: false; error: 'too_many' | 'not_found' | 'forbidden' };

/** The caller's own images for one message, in the order given; refused when any is missing or not theirs. */
export async function loadOperatorMediaForUser(ids: string[], userId: string | null): Promise<LoadMediaResult> {
  const unique = [...new Set(ids)];
  if (unique.length > OPERATOR_MEDIA_LIMITS.maxPerMessage) return { ok: false, error: 'too_many' };
  const out: OperatorMediaRow[] = [];
  for (const id of unique) {
    const row = await getOperatorMedia(id);
    if (!row) return { ok: false, error: 'not_found' };
    if (!userId || row.user_id !== userId) return { ok: false, error: 'forbidden' };
    out.push(row);
  }
  return { ok: true, media: out };
}

/** The image bytes as base64 (for an ACP image block or a Bedrock image block); null when the read fails. */
export async function readOperatorMediaBase64(row: Pick<OperatorMediaRow, 'object_path' | 'mime_type'>): Promise<{ mimeType: string; data: string } | null> {
  const s = supa();
  if (!s) return null;
  try {
    const r = await fetch(`${s.url}/storage/v1/object/${OPERATOR_MEDIA_BUCKET}/${encPath(row.object_path)}`, {
      headers: { apikey: s.key, Authorization: `Bearer ${s.key}` },
    });
    if (!r.ok) {
      console.warn(`${LOG} storage read failed (${r.status}) for ${row.object_path}`);
      return null;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    return { mimeType: row.mime_type, data: buf.toString('base64') };
  } catch (err) {
    console.warn(`${LOG} storage read threw:`, err instanceof Error ? err.message : err);
    return null;
  }
}
