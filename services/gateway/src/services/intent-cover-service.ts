/**
 * BOOTSTRAP-INTENT-COVER-GEN — server-side cover-photo generation for
 * the Find-a-Match preview card.
 *
 * Two responsibilities:
 *
 *   1. Generate a real, themed, content-safe cover image via the
 *      OpenAI Images API (gpt-image-1, conservative prompt template
 *      per dance / fitness / generic theme), upload the bytes to the
 *      `intent-covers` Supabase Storage bucket, and persist the
 *      resulting public URL on user_intents.cover_url.
 *
 *   2. When generation is unavailable (no API key, provider error,
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
import OpenAI from 'openai';
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
const MODEL = process.env.OPENAI_IMAGES_MODEL ?? 'gpt-image-1';
const IMAGE_SIZE = '1536x1024'; // 3:2 landscape — gpt-image-1 supported size closest to the 16:10 cover.

function getSupabase() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);
}

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiClient;
}

const PROMPTS: Record<CoverTheme, string> = {
  dance:
    'A photorealistic, vibrant landscape photograph of two adults practicing partner dance ' +
    'in a sunlit modern dance studio with wooden floors and mirrors. Documentary photography ' +
    'style, soft natural light, wide 16:9 composition. No text, no logos, no close-up faces.',
  fitness:
    'A photorealistic, vibrant landscape photograph of two adults stretching together in a ' +
    'bright modern gym with natural light through tall windows. Documentary photography style, ' +
    'wide 16:9 composition. No text, no logos.',
  generic:
    'A photorealistic, warm landscape photograph of a friendly adult community gathering in a ' +
    'sunlit cafe or park. Candid documentary photography style, wide 16:9 composition. ' +
    'No text, no logos.',
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
  const openai = getOpenAI();
  if (!openai) throw new CoverGenError('provider_failed', 'openai_key_missing');
  let response;
  try {
    response = await openai.images.generate({
      model: MODEL,
      prompt: PROMPTS[theme],
      size: IMAGE_SIZE as '1536x1024',
      n: 1,
    });
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'content_policy_violation' || e.code === 'moderation_blocked') {
      throw new CoverGenError('unsafe_prompt', e.message ?? 'content policy violation');
    }
    throw new CoverGenError('provider_failed', e.message ?? 'openai request failed');
  }
  const item = response.data?.[0];
  if (!item) throw new CoverGenError('provider_failed', 'no image returned');
  // gpt-image-1 returns base64 by default.
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item.url) {
    const r = await fetch(item.url);
    if (!r.ok) throw new CoverGenError('provider_failed', `download ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  throw new CoverGenError('provider_failed', 'image payload missing both b64_json and url');
}

async function uploadAiCover(args: { intentId: string; bytes: Buffer }): Promise<string> {
  const supabase = getSupabase();
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

  // Try AI gen → upload → persist.
  if (!DRY_RUN && process.env.OPENAI_API_KEY) {
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
