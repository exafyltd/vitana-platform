/**
 * VTID-03497 — Amazon Titan Image Generator provider (Bedrock).
 *
 * Build 3 of the 4 provider replacements that must exist before a GCP
 * shutdown (Polly ✅ → Bedrock vision/tools ✅ → **Titan image gen** → Nova
 * Sonic promotion). This is the one capability Claude cannot cover at all:
 * Vertex **Imagen** generates images, and no Anthropic model does.
 *
 * Two GCP consumers, not one (CLAUDE.md's changelog listed only the first):
 *   1. `cover-image-outpaint.ts` — 16:9 OUTPAINTING with a user-supplied mask
 *   2. `intent-cover-service.ts` — plain TEXT_IMAGE generation
 * Titan supports both task types, so both are mappable.
 *
 * Selected by `IMAGE_PROVIDER=vertex|bedrock`, **default `vertex`** — same
 * deliberate-opt-in shape as `TTS_PROVIDER` (§2c) and `BEDROCK_ROLE_ARN`
 * (§2b). Importing or deploying this changes nothing.
 *
 * ## Three Titan constraints that are NOT cosmetic
 *
 * 1. **Titan only accepts a fixed set of width/height pairs.** The outpaint
 *    canvas is 1600x900, which is NOT one of them. `nearestTitanSize()` maps
 *    to 1280x720 (the largest supported 16:9) and the caller upscales the
 *    result back. Sending 1600x900 straight through is a hard ValidationException,
 *    not a silent downgrade — but picking a non-16:9 size instead would letterbox
 *    the subject invisibly, so the mapping is aspect-aware and tested.
 *
 * 2. **Mask polarity is INVERTED relative to Imagen — and is UNVERIFIED.**
 *    Imagen's documented convention (see `cover-image-outpaint.ts`) is
 *    white = generate, black = keep. Titan's OUTPAINTING `maskImage` is
 *    documented the other way round: the masked (black) region is what gets
 *    regenerated. Getting this backwards regenerates the SUBJECT and keeps
 *    the margins — visually catastrophic, but a test that only asserts "bytes
 *    came back" passes happily. Because this session had **no AWS credentials
 *    to confirm it against the live API**, the polarity is a named constant
 *    with an env override (`TITAN_OUTPAINT_MASK_POLARITY`) so it can be
 *    corrected without a code change and redeploy. **Check this first if
 *    outpaint output looks wrong.**
 *
 * 3. **Region availability differs from the rest of Vitana's AWS estate.**
 *    Everything else here is `eu-central-1`; Titan Image Generator is not
 *    offered in every region. `AWS_TITAN_IMAGE_REGION` is therefore its own
 *    var (falling back to the Bedrock region, then `us-east-1`) rather than
 *    inheriting blindly — a wrong region fails at call time with an opaque
 *    model-not-found rather than anything that reads as "unsupported here".
 *
 * Verify all three with `scripts/images/verify-titan-image.ts` before
 * flipping `IMAGE_PROVIDER=bedrock`.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export type ImageProviderName = 'vertex' | 'bedrock';

/** Provider gate. Default `vertex` — deploying this flips nothing. */
export function getImageProvider(): ImageProviderName {
  const raw = (process.env.IMAGE_PROVIDER || 'vertex').trim().toLowerCase();
  if (raw === 'bedrock') return 'bedrock';
  if (raw !== 'vertex' && raw !== '') {
    console.warn(`[TITAN-IMAGE] Unrecognised IMAGE_PROVIDER='${raw}' — defaulting to 'vertex'.`);
  }
  return 'vertex';
}

export function getTitanRegion(): string {
  return (
    process.env.AWS_TITAN_IMAGE_REGION ||
    process.env.AWS_BEDROCK_REGION ||
    process.env.AWS_REGION ||
    'us-east-1'
  );
}

export function getTitanModelId(): string {
  return process.env.TITAN_IMAGE_MODEL_ID || 'amazon.titan-image-generator-v2:0';
}

/**
 * Whether a WHITE mask pixel means "generate here".
 *
 * Imagen: white generates. Titan is documented inverted (black generates),
 * hence the default. UNVERIFIED against the live API — see the header note.
 * Set `TITAN_OUTPAINT_MASK_POLARITY=white-generates` to flip without a deploy.
 */
export function titanWhiteGenerates(): boolean {
  const raw = (process.env.TITAN_OUTPAINT_MASK_POLARITY || 'black-generates').trim().toLowerCase();
  return raw === 'white-generates';
}

/**
 * Width/height pairs Titan Image Generator accepts. Anything else is a
 * ValidationException. Kept as an explicit table so the constraint is
 * greppable rather than buried in a resize call.
 */
export const TITAN_SUPPORTED_SIZES: ReadonlyArray<{ width: number; height: number }> = [
  { width: 1024, height: 1024 },
  { width: 768, height: 768 },
  { width: 512, height: 512 },
  { width: 768, height: 1152 },
  { width: 1152, height: 768 },
  { width: 768, height: 1280 },
  { width: 1280, height: 768 },
  { width: 640, height: 1408 },
  { width: 1408, height: 640 },
  { width: 640, height: 1536 },
  { width: 1536, height: 640 },
  { width: 720, height: 1280 },
  { width: 1280, height: 720 },
  { width: 640, height: 1152 },
  { width: 1152, height: 640 },
];

/**
 * Pick the supported Titan size closest to `width`x`height`, preferring the
 * nearest ASPECT RATIO first and only then the largest area.
 *
 * Aspect is weighted first on purpose: a 16:9 request satisfied by a square
 * canvas would silently letterbox or crop the subject, which is far worse
 * than a modest resolution drop. 1600x900 (the cover canvas) maps to
 * 1280x720, not 1024x1024.
 */
export function nearestTitanSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const targetAspect = width / height;
  let best = TITAN_SUPPORTED_SIZES[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const size of TITAN_SUPPORTED_SIZES) {
    const aspectErr = Math.abs(size.width / size.height - targetAspect) / targetAspect;
    // Area term only breaks ties between comparable aspects (hence the
    // small weight) — it must never outvote a better aspect match.
    const areaErr = 1 - Math.min(size.width * size.height, width * height) /
      Math.max(size.width * size.height, width * height);
    const score = aspectErr * 100 + areaErr;
    if (score < bestScore) {
      bestScore = score;
      best = size;
    }
  }
  return best;
}

export interface TitanImageSuccess {
  ok: true;
  /** Raw PNG bytes of the first returned image. */
  pngBytes: Buffer;
  model: string;
  upstream_ms: number;
}

export interface TitanImageError {
  ok: false;
  error: 'not_configured' | 'invoke_failed' | 'blocked' | 'empty_output';
  message: string;
}

export type TitanImageResult = TitanImageSuccess | TitanImageError;

let titanClient: BedrockRuntimeClient | null = null;
function getTitanClient(): BedrockRuntimeClient {
  if (!titanClient) {
    // Same HTTP/1.1 forcing as providers/bedrock.ts — the SDK's default
    // handler can negotiate HTTP/2, which breaks in Cloud Run's sandboxed
    // network stack (NGHTTP2_PROTOCOL_ERROR, confirmed under VTID-03403).
    titanClient = new BedrockRuntimeClient({
      region: getTitanRegion(),
      requestHandler: new NodeHttpHandler(),
    });
  }
  return titanClient;
}

/** Test seam — drop the memoized client so a new region applies. */
export function resetTitanClientForTests(): void {
  titanClient = null;
}

/** Shared invoke + response parsing for both task types. */
async function invokeTitan(body: Record<string, unknown>): Promise<TitanImageResult> {
  if (!process.env.BEDROCK_ROLE_ARN) {
    return {
      ok: false,
      error: 'not_configured',
      message: 'BEDROCK_ROLE_ARN not set; Titan image generation is dormant (VTID-03497)',
    };
  }

  const model = getTitanModelId();
  const start = Date.now();
  try {
    const resp = await getTitanClient().send(
      new InvokeModelCommand({
        modelId: model,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(body),
      }),
    );
    const payload = JSON.parse(new TextDecoder().decode(resp.body)) as {
      images?: string[];
      error?: string | null;
    };
    // Titan reports content-policy blocks in an `error` field on a 200 —
    // it does NOT throw. Treating that as success would return empty bytes.
    if (payload.error) {
      return { ok: false, error: 'blocked', message: String(payload.error).slice(0, 300) };
    }
    const b64 = payload.images?.[0];
    if (!b64) {
      return { ok: false, error: 'empty_output', message: 'Titan returned no image' };
    }
    return {
      ok: true,
      pngBytes: Buffer.from(b64, 'base64'),
      model,
      upstream_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      error: 'invoke_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Text-to-image. Replaces `intent-cover-service.ts`'s Imagen generate call. */
export async function generateTitanImage(opts: {
  prompt: string;
  width: number;
  height: number;
  negativePrompt?: string;
  cfgScale?: number;
  seed?: number;
}): Promise<TitanImageResult> {
  const size = nearestTitanSize(opts.width, opts.height);
  return invokeTitan({
    taskType: 'TEXT_IMAGE',
    textToImageParams: {
      text: opts.prompt,
      // Titan rejects an empty-string negativeText, so omit rather than blank.
      ...(opts.negativePrompt ? { negativeText: opts.negativePrompt } : {}),
    },
    imageGenerationConfig: {
      numberOfImages: 1,
      width: size.width,
      height: size.height,
      cfgScale: opts.cfgScale ?? 8.0,
      ...(typeof opts.seed === 'number' ? { seed: opts.seed } : {}),
    },
  });
}

/**
 * Outpainting. Replaces `cover-image-outpaint.ts`'s Imagen EDIT_MODE_OUTPAINT.
 *
 * `imagePng`/`maskPng` MUST already be at a Titan-supported size — the caller
 * owns resizing, because it also owns upscaling the result back and knows the
 * final canvas. `maskPng` polarity must match `titanWhiteGenerates()`; see the
 * header note, this is the most likely thing to be wrong on first live run.
 */
export async function outpaintTitanImage(opts: {
  imagePng: Buffer;
  maskPng: Buffer;
  prompt: string;
  width: number;
  height: number;
  /** 'DEFAULT' blends softly; 'PRECISE' honours the mask edge more strictly. */
  mode?: 'DEFAULT' | 'PRECISE';
}): Promise<TitanImageResult> {
  return invokeTitan({
    taskType: 'OUTPAINTING',
    outPaintingParams: {
      image: opts.imagePng.toString('base64'),
      maskImage: opts.maskPng.toString('base64'),
      text: opts.prompt,
      outPaintingMode: opts.mode ?? 'DEFAULT',
    },
    imageGenerationConfig: {
      numberOfImages: 1,
      width: opts.width,
      height: opts.height,
      cfgScale: 8.0,
    },
  });
}
