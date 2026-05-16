/**
 * VTID-02806h — Vertex Imagen outpainting for cover-photo uploads.
 *
 * The frontend already classifies aspect ratio and only calls this
 * service for sources NARROWER than 16:9 (portrait, square, 4:3).
 * For those it would otherwise have to letterbox-blur the side
 * margins; this service generates plausible content in those margins
 * via Imagen's edit/outpaint capability instead, matching what the
 * user used to do manually with external AI tools.
 *
 * Pipeline:
 *   1. Read source bytes from Supabase Storage (intent-covers bucket,
 *      `staging/{userId}/...` prefix).
 *   2. With sharp: compose a 16:9 canvas containing the source
 *      centered + scaled to the canvas height; build a binary mask
 *      that is BLACK over the source pixels and WHITE on the side
 *      margins (Imagen convention: white = generate, black = keep).
 *   3. Call the Imagen capability model with editMode=EDIT_MODE_OUTPAINT.
 *   4. Upload the result PNG to a final path the caller specified
 *      (typically `user-universal/{uid}/...` or `user-library/{uid}/...`).
 *   5. Delete the staging source so the bucket doesn't accumulate
 *      double copies.
 *
 * Service-role IO throughout — RLS does not gate the gateway.
 */

import { createClient } from '@supabase/supabase-js';
import { GoogleAuth } from 'google-auth-library';
import sharp from 'sharp';

const BUCKET = process.env.INTENT_COVERS_BUCKET ?? 'intent-covers';

// Imagen edit/outpaint runs on the capability model. The fast text-
// to-image model (imagen-3.0-fast-generate-001) doesn't support
// editMode parameters.
const CAPABILITY_MODEL =
  process.env.VERTEX_IMAGES_EDIT_MODEL ?? 'imagen-3.0-capability-001';
const VERTEX_PROJECT =
  process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || 'lovable-vitana-vers1';
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';

// Output canvas. Matches the phase-1 client-side dimensions so a
// passthrough / crop result and an outpaint result look the same.
const OUT_W = 1600;
const OUT_H = 900;

const OUTPAINT_PROMPT = [
  'Extend the existing photo naturally to a 16:9 widescreen aspect ratio.',
  'Continue the same setting, lighting, materials, and depth of field on the side margins.',
  'Photorealistic, documentary photography style. Real human skin and clothing.',
  'No cartoon, no illustration, no painting, no 3D render, no CGI, no AI-art look.',
  'No text, no captions, no logos, no watermarks.',
].join(' ');

export class CoverOutpaintError extends Error {
  constructor(
    public readonly code:
      | 'forbidden'
      | 'source_not_found'
      | 'source_too_large'
      | 'unsupported_mime'
      | 'provider_failed'
      | 'unsafe_prompt'
      | 'storage_failed'
      | 'invalid_path',
    message: string,
  ) {
    super(message);
    this.name = 'CoverOutpaintError';
  }
}

let googleAuth: GoogleAuth | null = null;
function getGoogleAuth(): GoogleAuth {
  if (!googleAuth) {
    googleAuth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }
  return googleAuth;
}

function getSupabase() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);
}

/**
 * Validate that `path` lives in the caller's own storage namespace
 * under one of the writable prefixes. Reuses the same convention as
 * the storage RLS policies: `<prefix>/<userId>/...`.
 */
function assertOwnedPath(
  path: string,
  userId: string,
  allowedPrefixes: readonly string[],
): void {
  const parts = path.split('/');
  if (parts.length < 3) {
    throw new CoverOutpaintError('invalid_path', `path too shallow: ${path}`);
  }
  if (!allowedPrefixes.includes(parts[0])) {
    throw new CoverOutpaintError(
      'invalid_path',
      `path prefix must be one of ${allowedPrefixes.join(', ')}: ${path}`,
    );
  }
  if (parts[1] !== userId) {
    throw new CoverOutpaintError(
      'forbidden',
      `path's user segment ${parts[1]} does not match caller ${userId}`,
    );
  }
}

/**
 * Compose a 16:9 canvas with the source image centered + scaled to
 * fit canvas height, plus the matching mask (WHITE in the margins
 * where Imagen should generate new content, BLACK over the source).
 *
 * Returns the canvas + mask as PNG buffers ready for the Imagen
 * predict body (base64-encoded).
 */
async function composeCanvasAndMask(
  srcBytes: Buffer,
): Promise<{ canvasPng: Buffer; maskPng: Buffer; outW: number; outH: number }> {
  const meta = await sharp(srcBytes).metadata();
  if (!meta.width || !meta.height) {
    throw new CoverOutpaintError('unsupported_mime', 'cannot read source dimensions');
  }
  // Scale source so its height matches the canvas, preserving aspect.
  const fittedH = OUT_H;
  const fittedW = Math.max(1, Math.round((meta.width / meta.height) * fittedH));
  // The composition is meaningful only when the source is narrower
  // than the target. The frontend already filters on this; we double-
  // check defensively so we don't create a degenerate zero-margin mask.
  if (fittedW >= OUT_W) {
    throw new CoverOutpaintError(
      'unsupported_mime',
      'source already fills 16:9 canvas after height-fit; client should not have called outpaint',
    );
  }
  const offsetX = Math.round((OUT_W - fittedW) / 2);

  const fittedSrcPng = await sharp(srcBytes)
    .resize(fittedW, fittedH, { fit: 'fill' })
    .png()
    .toBuffer();

  // Canvas: white side margins for Imagen to overwrite, source pasted center.
  const canvasPng = await sharp({
    create: {
      width: OUT_W,
      height: OUT_H,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([{ input: fittedSrcPng, left: offsetX, top: 0 }])
    .png()
    .toBuffer();

  // Mask: BLACK over the source area, WHITE on the side margins.
  // We build it by starting from a fully-WHITE canvas and pasting a
  // BLACK rectangle at (offsetX, 0) sized fittedW x fittedH.
  const blackCenter = await sharp({
    create: {
      width: fittedW,
      height: fittedH,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer();

  const maskPng = await sharp({
    create: {
      width: OUT_W,
      height: OUT_H,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([{ input: blackCenter, left: offsetX, top: 0 }])
    .png()
    .toBuffer();

  return { canvasPng, maskPng, outW: OUT_W, outH: OUT_H };
}

/**
 * Hit the Vertex Imagen capability model in outpaint mode.
 * Throws CoverOutpaintError on any provider/network failure so the
 * caller can fall back gracefully.
 */
async function callImagenOutpaint(
  canvasPng: Buffer,
  maskPng: Buffer,
): Promise<Buffer> {
  if (!VERTEX_PROJECT) throw new CoverOutpaintError('provider_failed', 'gcp_project_unset');

  let token: string;
  try {
    const client = await getGoogleAuth().getClient();
    const tokenResponse = await client.getAccessToken();
    if (!tokenResponse.token) throw new Error('no access token from GoogleAuth');
    token = tokenResponse.token;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'gcp auth failed';
    throw new CoverOutpaintError('provider_failed', message);
  }

  const url =
    `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}` +
    `/locations/${VERTEX_LOCATION}/publishers/google/models/${CAPABILITY_MODEL}:predict`;

  const body = {
    instances: [
      {
        prompt: OUTPAINT_PROMPT,
        referenceImages: [
          {
            referenceType: 'REFERENCE_TYPE_RAW',
            referenceId: 1,
            referenceImage: { bytesBase64Encoded: canvasPng.toString('base64') },
          },
          {
            referenceType: 'REFERENCE_TYPE_MASK',
            referenceId: 2,
            referenceImage: { bytesBase64Encoded: maskPng.toString('base64') },
            maskImageConfig: {
              maskMode: 'MASK_MODE_USER_PROVIDED',
              dilation: 0.01,
            },
          },
        ],
      },
    ],
    parameters: {
      editMode: 'EDIT_MODE_OUTPAINT',
      sampleCount: 1,
      personGeneration: 'allow_adult',
      safetyFilterLevel: 'block_some',
      addWatermark: false,
    },
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'vertex request failed';
    throw new CoverOutpaintError('provider_failed', message);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (response.status === 400 && /RAI|safety|blocked/i.test(text)) {
      throw new CoverOutpaintError(
        'unsafe_prompt',
        text.slice(0, 240) || 'content policy violation',
      );
    }
    throw new CoverOutpaintError(
      'provider_failed',
      `vertex ${response.status}: ${text.slice(0, 240) || response.statusText}`,
    );
  }

  const json = (await response.json()) as {
    predictions?: { bytesBase64Encoded?: string; mimeType?: string }[];
  };
  const b64 = json.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) throw new CoverOutpaintError('provider_failed', 'imagen returned no image');
  return Buffer.from(b64, 'base64');
}

export interface OutpaintArgs {
  /** Storage path under intent-covers, e.g. `staging/<uid>/abc.png`. */
  sourcePath: string;
  /** Final destination path. Must be `user-universal/<uid>/...`
   *  or `user-library/<uid>/...`. */
  targetPath: string;
  /** auth.uid() of the calling user. */
  userId: string;
}

export interface OutpaintResult {
  /** Public URL of the final 16:9 PNG. */
  url: string;
  /** Stored path under intent-covers. */
  path: string;
}

const SOURCE_PREFIXES = ['staging'] as const;
const TARGET_PREFIXES = ['user-universal', 'user-library'] as const;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024; // 12 MB

export async function outpaintCoverImage(args: OutpaintArgs): Promise<OutpaintResult> {
  assertOwnedPath(args.sourcePath, args.userId, SOURCE_PREFIXES);
  assertOwnedPath(args.targetPath, args.userId, TARGET_PREFIXES);

  const supabase = getSupabase();

  // 1. Download source.
  const { data: blob, error: dlErr } = await supabase.storage
    .from(BUCKET)
    .download(args.sourcePath);
  if (dlErr || !blob) {
    throw new CoverOutpaintError('source_not_found', dlErr?.message ?? 'download failed');
  }
  const arr = await blob.arrayBuffer();
  if (arr.byteLength > MAX_SOURCE_BYTES) {
    throw new CoverOutpaintError(
      'source_too_large',
      `source is ${arr.byteLength} bytes (max ${MAX_SOURCE_BYTES})`,
    );
  }
  const srcBytes = Buffer.from(arr);

  // 2. Compose 16:9 canvas + mask.
  const { canvasPng, maskPng } = await composeCanvasAndMask(srcBytes);

  // 3. Call Imagen.
  const resultPng = await callImagenOutpaint(canvasPng, maskPng);

  // 4. Upload final.
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(args.targetPath, resultPng, {
      contentType: 'image/png',
      upsert: true,
    });
  if (upErr) throw new CoverOutpaintError('storage_failed', upErr.message);

  // 5. Best-effort delete of the staging source. A failure here is
  //    not fatal — periodic cleanup can sweep orphaned staging files.
  await supabase.storage
    .from(BUCKET)
    .remove([args.sourcePath])
    .catch(() => undefined);

  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(args.targetPath);
  return { url: urlData.publicUrl, path: args.targetPath };
}
