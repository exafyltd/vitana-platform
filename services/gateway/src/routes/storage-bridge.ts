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
 * **Scope, deliberately not the full 5-function surface:** this covers
 * upload/remove/public-url/list — the operations whose payload is either
 * absent or comfortably inside the gateway's 2mb JSON body limit
 * (`express.json({ limit: '2mb' })`, index.ts). Two real gaps are left
 * OPEN rather than faked, matching this migration's "ai-chat's streaming
 * legs" precedent (documented as deliberately unfinished, not silently
 * declared done):
 *
 * 1. **No `/download`.** `extract-video-meta` downloads whole source videos
 *    before thumbnailing — base64-in-JSON would add ~33% overhead on top of
 *    an already-unbounded file size, and 2mb is nowhere near enough for a
 *    real video clip. That function is not wired to this bridge at all
 *    (partially wiring it — upload/public-url through the bridge, download
 *    still direct-to-Supabase — would split one logical operation across
 *    two storage backends, which `storage-provider.ts`'s own header comment
 *    already rules out: "never mixed per-call"). Needs either a raw-binary
 *    streaming endpoint or a presigned-URL hand-off instead of a JSON
 *    bridge — real, separate follow-up work.
 * 2. **No `/signed-url`.** `voucher-download-pdf` needs a signed URL for a
 *    private bucket, which needs `@aws-sdk/s3-request-presigner` — not a
 *    dependency this codebase has today. Adding it is a one-line
 *    `package.json` change but a real dependency-surface decision this
 *    pass leaves to whoever picks up that function's wiring, rather than
 *    bundling an unrelated dependency add into this route's first cut.
 *
 * What IS fully covered: `generate-event-image`, `generate-maxina-summer-
 * events` (upload + public-url, no download/signing needed), and
 * `request-account-deletion` (list + remove, confirmed against its real
 * `USER_STORAGE_BUCKETS`/`.list(userId)`/`.remove(filePaths)` call shape).
 */

import { Router, Request, Response } from 'express';
import { requireServiceOrAdmin } from '../middleware/require-service-or-admin';
import { storageUpload, storageRemove, storagePublicUrl, storageList } from '../services/storage/storage-provider';

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

export default router;
