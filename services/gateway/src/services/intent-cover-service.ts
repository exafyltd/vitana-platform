/**
 * BOOTSTRAP-INTENT-COVER-GEN — server-side cover-photo generation for
 * the Find-a-Match preview card.
 *
 * Two responsibilities:
 *
 *   1. Generate a real, themed, content-safe cover image via
 *      Vertex AI Imagen (the same GCP project the gateway already
 *      runs on — no new vendor billing). Uploads bytes to the
 *      `intent-covers` Supabase Storage bucket and persists the
 *      resulting public URL on user_intents.cover_url.
 *
 *   2. When generation is unavailable (no GCP creds, provider error,
 *      content-policy reject, storage failure), deterministically
 *      pick from a small curated server-shipped fallback library so
 *      every intent still ends up with a presentable cover.
 *
 * Caching + rate-limiting:
 *   - Cache hit: a cover_url already on the row → return it (unless `force`).
 *   - Per-user rate-limit: counts cover_generated_at in the last 24h.
 *
 * Used by:
 *   - POST /api/v1/intents             — fire-and-forget after voice/AI posts.
 *   - POST /api/v1/intents/:id/cover/generate — explicit user request.
 *   - intent-match-enrich              — read-only via getIntentCoverUrl.
 */

import { createClient } from '@supabase/supabase-js';
import { GoogleAuth } from 'google-auth-library';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';

export type CoverTheme = 'dance' | 'fitness' | 'generic';

export type CoverSource = 'user_upload' | 'ai_generated' | 'fallback_curated';

export interface GenerateCoverArgs {
  intentId: string;
  userId: string;
  theme: CoverTheme;
  /** When true, bypass the cache and produce a fresh image. */
  force?: boolean;
}

export interface GenerateCoverResult {
  cover_url: string;
  source: CoverSource;
  cached: boolean;
}

export class CoverGenError extends Error {
  constructor(
    public readonly code:
      | 'rate_limited'
      | 'forbidden'
      | 'not_found'
      | 'storage_failed'
      | 'provider_failed'
      | 'unsafe_prompt',
    message: string,
  ) {
    super(message);
    this.name = 'CoverGenError';
  }
}

const BUCKET = process.env.INTENT_COVERS_BUCKET ?? 'intent-covers';
const RATE_LIMIT_PER_DAY = Number(process.env.INTENT_COVER_RATE_LIMIT_PER_DAY ?? '10');
const DRY_RUN = (process.env.INTENT_COVER_DRY_RUN ?? '').toLowerCase() === 'true';

// Vertex AI Imagen runs in the same GCP project as the gateway. Default
// to the cheap fast variant; override via VERTEX_IMAGES_MODEL.
//   imagen-3.0-fast-generate-001  ~ low cost, 1-2s latency
//   imagen-3.0-generate-002       ~ higher quality, slower
//   imagen-4.0-fast-generate-preview-* — newer when GA
const IMAGEN_MODEL = process.env.VERTEX_IMAGES_MODEL ?? 'imagen-3.0-fast-generate-001';
const VERTEX_PROJECT =
  process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || 'lovable-vitana-vers1';
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';

function getSupabase() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);
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

const PROMPTS: Record<CoverTheme, string> = {
  // Hero composition: a single smiling adult (man or woman) in
  // sharp focus in the foreground, with a softly blurred group of
  // dance / fitness participants behind them. Mirrors the look of
  // the reference cover the user shared.
  dance:
    'A photorealistic, vibrant landscape photograph of one smiling adult — a man or a woman, ' +
    'mid-twenties to late-thirties — facing the camera in the foreground in sharp focus, with ' +
    'a softly blurred group of fellow dancers practising partner dance behind them in a sunlit ' +
    'modern dance studio with wooden floors and mirrors. Warm natural light, documentary ' +
    'photography style, wide 16:9 composition. Friendly, welcoming mood. No text, no logos.',
  fitness:
    'A photorealistic, vibrant landscape photograph of one smiling adult — a man or a woman, ' +
    'mid-twenties to late-thirties — facing the camera in the foreground in sharp focus, with ' +
    'a softly blurred group of fellow gym-goers stretching, training, or doing a class behind ' +
    'them in a bright modern gym with natural light through tall windows. Documentary ' +
    'photography style, wide 16:9 composition. Friendly, welcoming mood. No text, no logos.',
  generic:
    'A photorealistic, warm landscape photograph of one smiling adult — a man or a woman, ' +
    'mid-twenties to late-thirties — in sharp focus in the foreground, with a softly blurred ' +
    'group of friendly community members behind them in a sunlit cafe, park, or studio. ' +
    'Candid documentary photography style, wide 16:9 composition. No text, no logos.',
};

// Resolve the static fallback library directory at runtime.
// Built JS lives at services/gateway/dist/services/intent-cover-service.js;
// the static covers ship at services/gateway/static/intent-covers/.
function fallbackDir(): string {
  // CommonJS __dirname is the compiled file's directory.
  // From dist/services/ → ../../static/intent-covers; from src/services → ../../static/intent-covers.
  return path.resolve(__dirname, '..', '..', 'static', 'intent-covers');
}

const FALLBACK_FILES: Record<CoverTheme, string[]> = {
  dance: ['dance/01.jpg', 'dance/02.jpg', 'dance/03.jpg'],
  fitness: ['fitness/01.jpg', 'fitness/02.jpg', 'fitness/03.jpg'],
  generic: ['generic/01.jpg', 'generic/02.jpg'],
};

function fallbackKeyForSeed(theme: CoverTheme, seed: string): string {
  const list = FALLBACK_FILES[theme] ?? FALLBACK_FILES.generic;
  const h = createHash('sha256').update(seed).digest();
  // Read a single byte for the modulo — plenty of entropy for a tiny pool.
  const idx = h[0] % list.length;
  return list[idx];
}

async function uploadFallbackCover(args: {
  intentId: string;
  theme: CoverTheme;
}): Promise<string> {
  const supabase = getSupabase();
  const file = fallbackKeyForSeed(args.theme, args.intentId);
  const localPath = path.join(fallbackDir(), file);
  const bytes = await fs.readFile(localPath);
  const remotePath = `fallback/${args.intentId}.jpg`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(remotePath, bytes, { contentType: 'image/jpeg', upsert: true });
  if (error) throw new CoverGenError('storage_failed', error.message);
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(remotePath);
  return data.publicUrl;
}

async function generateAiCover(theme: CoverTheme): Promise<Buffer> {
  if (!VERTEX_PROJECT) throw new CoverGenError('provider_failed', 'gcp_project_unset');

  let token: string;
  try {
    const client = await getGoogleAuth().getClient();
    const tokenResponse = await client.getAccessToken();
    if (!tokenResponse.token) throw new Error('no access token from GoogleAuth');
    token = tokenResponse.token;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'gcp auth failed';
    throw new CoverGenError('provider_failed', message);
  }

  const url =
    `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}` +
    `/locations/${VERTEX_LOCATION}/publishers/google/models/${IMAGEN_MODEL}:predict`;

  // Imagen prediction request. `personGeneration: 'allow_adult'` lets us
  // ship the smiling-individual composition; `safetyFilterLevel: 'block_some'`
  // (default) keeps the existing content guardrails.
  const body = {
    instances: [{ prompt: PROMPTS[theme] }],
    parameters: {
      sampleCount: 1,
      aspectRatio: '16:9',
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
    throw new CoverGenError('provider_failed', message);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    // Vertex returns 400 with `RAI_*` codes for safety blocks.
    if (response.status === 400 && /RAI|safety|blocked/i.test(text)) {
      throw new CoverGenError('unsafe_prompt', text.slice(0, 240) || 'content policy violation');
    }
    throw new CoverGenError(
      'provider_failed',
      `vertex ${response.status}: ${text.slice(0, 240) || response.statusText}`,
    );
  }

  const json = (await response.json()) as {
    predictions?: { bytesBase64Encoded?: string; mimeType?: string }[];
  };
  const b64 = json.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) throw new CoverGenError('provider_failed', 'imagen returned no image');
  return Buffer.from(b64, 'base64');
}

async function uploadAiCover(args: { intentId: string; bytes: Buffer }): Promise<string> {
  const supabase = getSupabase();
  // Imagen returns PNG bytes by default; keep .png so the Content-Type
  // header is correct on Supabase Storage.
  const remotePath = `ai/${args.intentId}.png`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(remotePath, args.bytes, { contentType: 'image/png', upsert: true });
  if (error) throw new CoverGenError('storage_failed', error.message);
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(remotePath);
  return data.publicUrl;
}

async function checkRateLimit(userId: string): Promise<void> {
  if (RATE_LIMIT_PER_DAY <= 0) return; // disabled.
  const supabase = getSupabase();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from('user_intents')
    .select('intent_id', { count: 'exact', head: true })
    .eq('requester_user_id', userId)
    .gte('cover_generated_at', since);
  if (error) {
    // Fail open — don't block on a count failure, just log.
    console.warn('[cover-gen] rate-limit count failed:', error.message);
    return;
  }
  if ((count ?? 0) >= RATE_LIMIT_PER_DAY) {
    throw new CoverGenError('rate_limited', `cover regen quota reached (${RATE_LIMIT_PER_DAY}/day)`);
  }
}

async function persistCover(args: {
  intentId: string;
  userId: string;
  url: string;
  source: CoverSource;
}): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('user_intents')
    .update({
      cover_url: args.url,
      cover_generated_at: new Date().toISOString(),
      cover_source: args.source,
    })
    .eq('intent_id', args.intentId)
    .eq('requester_user_id', args.userId);
  if (error) throw new CoverGenError('storage_failed', error.message);
}

/**
 * Idempotent cover-photo generator.
 *
 * Resolution order:
 *   1. cache hit (cover_url already set) and !force → return it.
 *   2. AI generation via OpenAI Images, uploaded to Supabase Storage.
 *   3. Curated fallback library (server-shipped JPGs).
 *
 * Throws CoverGenError for the route layer to map to HTTP statuses.
 * Never throws for "fallback used" — that's a successful result with
 * `source: 'fallback_curated'`.
 */
export async function generateCoverForIntent(
  args: GenerateCoverArgs,
): Promise<GenerateCoverResult> {
  const supabase = getSupabase();

  const { data: intent, error } = await supabase
    .from('user_intents')
    .select('intent_id, requester_user_id, cover_url')
    .eq('intent_id', args.intentId)
    .maybeSingle();
  if (error) throw new CoverGenError('storage_failed', error.message);
  if (!intent) throw new CoverGenError('not_found', 'intent_not_found');
  if ((intent as { requester_user_id: string }).requester_user_id !== args.userId) {
    throw new CoverGenError('forbidden', 'intent_not_owned_by_caller');
  }

  const existing = (intent as { cover_url: string | null }).cover_url;
  if (existing && !args.force) {
    return { cover_url: existing, source: 'ai_generated', cached: true };
  }

  await checkRateLimit(args.userId);

  // Try AI gen → upload → persist. Vertex auth runs off the Cloud
  // Run service-account credentials by default; tests / local dev
  // can disable the call by setting INTENT_COVER_DRY_RUN=true.
  if (!DRY_RUN) {
    try {
      const bytes = await generateAiCover(args.theme);
      const url = await uploadAiCover({ intentId: args.intentId, bytes });
      await persistCover({
        intentId: args.intentId,
        userId: args.userId,
        url,
        source: 'ai_generated',
      });
      return { cover_url: url, source: 'ai_generated', cached: false };
    } catch (err) {
      // Provider / safety / storage errors fall through to the curated fallback.
      console.warn('[cover-gen] AI path failed; using curated fallback:', err);
    }
  }

  // Fallback path.
  const url = await uploadFallbackCover({ intentId: args.intentId, theme: args.theme });
  await persistCover({
    intentId: args.intentId,
    userId: args.userId,
    url,
    source: 'fallback_curated',
  });
  return { cover_url: url, source: 'fallback_curated', cached: false };
}

/**
 * Map an intent's `category` (e.g., "dance.salsa", "fitness.gym") to a cover theme.
 * Mirrors the frontend `themeFromCategory` so the picker and the gateway agree.
 */
export function themeFromCategory(category: string | null | undefined): CoverTheme {
  if (!category) return 'generic';
  if (category.startsWith('dance.')) return 'dance';
  if (category.startsWith('fitness.')) return 'fitness';
  return 'generic';
}
