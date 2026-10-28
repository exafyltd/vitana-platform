/**
 * Storage Bridge — gateway-owned object-storage facade for Supabase edge
 * functions (Aurora migration B6, VTID-03815 continuation /
 * AURORA-B6-STORAGE-INVENTORY.md's 2026-09-11 "edge functions were never
 * checked either" addendum).
 *
 * Why this exists: that addendum found 5 vitana-v1 edge functions calling
 * Supabase Storage's `.storage.*` client directly, with no
 * `STORAGE_PROVIDER`-equivalent seam the way `services/storage/
 * storage-provider.ts` already gives the gateway itself (VTID-03765). Rather
 * than give every edge function its own AWS SDK dependency and IAM-role
 * credential (Deno edge runtimes are not where `BEDROCK_ROLE_ARN`-style
 * roles live, and duplicating the S3 client five times risks the exact
 * "five copies drift" failure this codebase's CHANGE LOG already names
 * twice), this route puts ONE storage call point on the gateway — same
 * shape as `routes/ai-bridge.ts` (B7) — and the vitana-v1 companion,
 * `supabase/functions/_shared/storage-bridge-client.ts`, calls it instead.
 *
 * Auth: service-to-service only, `requireServiceOrAdmin` (GATEWAY_SERVICE_TOKEN
 * bearer, or an exafy_admin JWT for manual testing) — identical gate to
 * `ai-bridge.ts`. There is no anonymous path.
 *
 * **Scope, now the full 5-function surface (2026-09-11 follow-up).** The
 * first cut covered upload/remove/public-url/list — anything whose payload
 * is either absent or comfortably inside the gateway's 2mb JSON body limit
 * (`express.json({ limit: '2mb' })`, index.ts) — and left two real gaps
 * open (`voucher-download-pdf`'s signed URL, `extract-video-meta`'s video
 * download). Both are now closed by `/signed-url`
 * (`storage-provider.ts`'s new `storageSignedUrl`, backed by
 * `@aws-sdk/s3-request-presigner` on the S3 side and Supabase's own
 * `createSignedUrl()` otherwise):
 *
 * - `voucher-download-pdf` gets a real signed link to hand the user
 *   directly — that was always the natural fit.
 * - `extract-video-meta` no longer needs a `/download` endpoint at all: it
 *   asks this bridge for a signed URL, then `fetch()`s the video bytes
 *   itself, straight from Supabase/S3 — the bytes never pass through the
 *   gateway, so the 2mb body-limit mismatch that blocked a byte-proxying
 *   `/download` route never applies. This also means the function's
 *   upload/public-url legs (thumbnail) and its "download" leg (source
 *   video) both now go through the SAME bridge, so `storage-provider.ts`'s
 *   "never mixed per-call" rule is honored, not sidestepped.
 *
 * All 5 identified edge functions are covered: `generate-event-image`,
 * `generate-maxina-summer-events` (upload + public-url),
 * `request-account-deletion` (list + remove), `voucher-download-pdf`
 * (upload + signed-url), `extract-video-meta` (signed-url read + upload +
 * public-url).
 */

import { Router, Request, Response } from 'express';
import { requireServiceOrAdmin } from '../middleware/require-service-or-admin';
import { storageUpload, storageRemove, storagePublicUrl, storageList, storageSignedUrl } from '../services/storage/storage-provider';

const router = Router();

// Node's `Buffer.from(str, 'base64')` never throws on malformed input — it
// silently decodes whatever valid base64 characters it finds and drops the
// rest, so a try/catch around the decode call (the pattern ai-bridge.ts's
// /transcribe route also uses) never actually catches anything; garbage
// input would otherwise upload silently-corrupted bytes instead of being
// rejected. A charset check before decoding is the only real guard.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
function isValidBase64(input: string): boolean {
  return BASE64_RE.test(input.replace(/\s/g, ''));
}

router.post('/upload', requireServiceOrAdmin, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: a storage call-through with no local state
  // transition of its own — same category as ai-bridge's /generate.
  const body = req.body as {
    bucket?: string;
    path?: string;
    contentBase64?: string;
    contentType?: string;
    upsert?: boolean;
    cacheControl?: string;
  };

  if (!body?.bucket || typeof body.bucket !== 'string') {
    res.status(400).json({ ok: false, error: 'bucket must be a non-empty string' });
    return;
  }
  if (!body?.path || typeof body.path !== 'string') {
    res.status(400).json({ ok: false, error: 'path must be a non-empty string' });
    return;
  }
  if (!body?.contentBase64 || typeof body.contentBase64 !== 'string') {
    res.status(400).json({ ok: false, error: 'contentBase64 must be a non-empty string' });
    return;
  }
  if (!isValidBase64(body.contentBase64)) {
    res.status(400).json({ ok: false, error: 'contentBase64 is not valid base64' });
    return;
  }

  const bytes = Buffer.from(body.contentBase64, 'base64');
  if (bytes.byteLength === 0) {
    res.status(400).json({ ok: false, error: 'contentBase64 decoded to zero bytes' });
    return;
  }

  const { error } = await storageUpload(body.bucket, body.path, bytes, {
    contentType: body.contentType,
    upsert: body.upsert,
    cacheControl: body.cacheControl,
  });

  if (error) {
    res.status(502).json({ ok: false, error: 'upload_failed', message: error.message });
    return;
  }

  res.status(200).json({ ok: true });
});

router.post('/remove', requireServiceOrAdmin, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: a storage call-through, same category as above.
  const body = req.body as { bucket?: string; paths?: string[] };

  if (!body?.bucket || typeof body.bucket !== 'string') {
    res.status(400).json({ ok: false, error: 'bucket must be a non-empty string' });
    return;
  }
  if (!Array.isArray(body?.paths) || body.paths.some((p) => typeof p !== 'string')) {
    res.status(400).json({ ok: false, error: 'paths must be an array of strings' });
    return;
  }

  const { error } = await storageRemove(body.bucket, body.paths);
  if (error) {
    res.status(502).json({ ok: false, error: 'remove_failed', message: error.message });
    return;
  }

  res.status(200).json({ ok: true, removed: body.paths.length });
});

router.get('/public-url', requireServiceOrAdmin, (req: Request, res: Response) => {
  // impact-allow-no-oasis: pure URL construction, no I/O and no state
  // transition — the cheapest possible category on this route.
  const bucket = typeof req.query.bucket === 'string' ? req.query.bucket : undefined;
  const path = typeof req.query.path === 'string' ? req.query.path : undefined;

  if (!bucket) {
    res.status(400).json({ ok: false, error: 'bucket query param is required' });
    return;
  }
  if (!path) {
    res.status(400).json({ ok: false, error: 'path query param is required' });
    return;
  }

  try {
    const url = storagePublicUrl(bucket, path);
    res.status(200).json({ ok: true, url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ ok: false, error: 'public_url_failed', message });
  }
});

router.post('/list', requireServiceOrAdmin, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: a read-only storage listing, same category as
  // ai-bridge's /generate.
  const body = req.body as { bucket?: string; prefix?: string; limit?: number };

  if (!body?.bucket || typeof body.bucket !== 'string') {
    res.status(400).json({ ok: false, error: 'bucket must be a non-empty string' });
    return;
  }
  if (typeof body?.prefix !== 'string') {
    res.status(400).json({ ok: false, error: 'prefix must be a string' });
    return;
  }

  const { data, error } = await storageList(body.bucket, body.prefix, { limit: body.limit });
  if (error) {
    res.status(502).json({ ok: false, error: 'list_failed', message: error.message });
    return;
  }

  res.status(200).json({ ok: true, files: data ?? [] });
});

router.post('/signed-url', requireServiceOrAdmin, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: pure URL generation (a presign/sign call, no
  // object read or write), same category as /public-url above.
  const body = req.body as { bucket?: string; path?: string; expiresInSeconds?: number };

  if (!body?.bucket || typeof body.bucket !== 'string') {
    res.status(400).json({ ok: false, error: 'bucket must be a non-empty string' });
    return;
  }
  if (!body?.path || typeof body.path !== 'string') {
    res.status(400).json({ ok: false, error: 'path must be a non-empty string' });
    return;
  }
  const expiresInSeconds = typeof body.expiresInSeconds === 'number' && body.expiresInSeconds > 0
    ? body.expiresInSeconds
    : 3600;

  const { url, error } = await storageSignedUrl(body.bucket, body.path, expiresInSeconds);
  if (error || !url) {
    res.status(502).json({ ok: false, error: 'signed_url_failed', message: error?.message ?? 'no URL returned' });
    return;
  }

  res.status(200).json({ ok: true, url, expiresInSeconds });
});

export default router;
