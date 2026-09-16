/**
 * Fish Audio TTS — language-coverage fallback for Polly (VTID-03970).
 *
 * Polly cannot speak Serbian at all (`POLLY_UNSUPPORTED_LANGS`, see
 * `polly.ts`), and with GCP decommissioned there is no Google TTS left to
 * fall back to either — CLAUDE.md §2c has called this "currently
 * silent/broken in production" since VTID-03495. Fish Audio is a
 * multilingual zero-shot TTS provider that DOES cover Serbian (and many
 * other languages Polly/Nova Sonic don't), so this module exists to fill
 * exactly that gap — never to replace Polly for languages it already
 * serves well.
 *
 * ## This is a FALLBACK, not a primary provider
 *
 * `TTS_PROVIDER` (see `tts-provider.ts`) still only selects `google` or
 * `polly`. Fish is not a third value for that switch — it is invoked from
 * inside `tryPollySynthesis()`'s failure branch, ONLY when the language is
 * one Polly has no voice for at all (not on a transient Polly API error —
 * a real outage should surface as an outage, not be silently papered over
 * by routing every failure through an unverified third-party). This keeps
 * the existing "one seam, every call site benefits" architecture the
 * header of `tts-provider.ts` documents, instead of adding a second
 * seam every caller has to know about.
 *
 * ## Explicit opt-in, explicit key — same shape as every other provider here
 *
 * Gated on BOTH `TTS_FISH_FALLBACK_ENABLED=true` AND `FISH_API_KEY` being
 * set (mirrors `BEDROCK_ROLE_ARN`'s "unconfigured → not_configured → the
 * router skips it" contract, CLAUDE.md IF-THEN 31). Deploying this file
 * changes nothing until both are set explicitly.
 *
 * ## Voice selection — curated, not user-supplied
 *
 * Fish Audio hosts community-uploaded voice clones with no content
 * moderation on their sample text. A Serbian voice suggested for this
 * integration (`f8c26ecae994449faf73bcfae844076b`, "Srpski Razgovorni
 * Glas") turned out to carry an explicit sexual description and
 * `sexy`/`intimate`/`breathy` tags — completely unusable for a health/
 * wellness assistant. `FISH_VOICES` below is therefore a short, manually
 * reviewed table (like `POLLY_VOICES`), not a lookup into Fish's public
 * catalog at request time. Adding a language means picking (and reading
 * the full description of) a specific `reference_id`, the same discipline
 * `polly.ts`'s per-language table already applies.
 *
 * `sr` → `2ad62aaf885e4a14add09fe4a38ffd23` ("Milica - Female Serbian"),
 * published by Fish Audio's own official account (`author.nickname ===
 * 'Fish Official'`), described as "A natural, professional Serbian voice
 * ... suited to voice assistants, customer support and everyday
 * narration" — verified via `GET /model/{id}` 2026-09-16, not assumed
 * from the search listing.
 *
 * ## Not yet verified against a live synthesis call
 *
 * Same posture `polly.ts` shipped with originally (CLAUDE.md §2c): this
 * session confirmed the voice via Fish's model-metadata API and validated
 * the request/response shape against the public API docs, but the actual
 * `POST /v1/tts` call returned HTTP 402 ("Insufficient API credit — API
 * credit is managed independently from platform credit") — the supplied
 * key has no funded API credit. Until that's resolved and a real
 * synthesis is observed, treat the `pcm`-format sample rate below as a
 * documented assumption, not a confirmed fact — see the comment on
 * `FISH_PCM_SAMPLE_RATE_HZ`. `scripts/tts/verify-fish-voice.ts` exists to
 * confirm both before flipping `TTS_FISH_FALLBACK_ENABLED=true` anywhere.
 */

export interface FishVoiceConfig {
  /** Fish Audio `reference_id` — selects voice timbre/style. */
  referenceId: string;
  /** Human-readable label for logs, matching Polly's `voice` field shape. */
  label: string;
}

/**
 * Language → Fish Audio voice. Deliberately small and manually curated —
 * see the module header on why this is not a live catalog lookup.
 */
const FISH_VOICES: Record<string, FishVoiceConfig> = {
  sr: { referenceId: '2ad62aaf885e4a14add09fe4a38ffd23', label: 'Milica (Fish Official)' },
};

export function resolveFishVoice(lang: string): FishVoiceConfig | null {
  const normalized = (lang || '').toLowerCase().split(/[-_]/)[0].slice(0, 2);
  return FISH_VOICES[normalized] ?? null;
}

/**
 * Fish's production TTS model as of 2026-09 (docs.fish.audio): `s2.1-pro`
 * supersedes `s2-pro` with "improved quality, latency, and throughput" per
 * Fish's own docs. Overridable per CLAUDE.md's "always specify model_name
 * explicitly" rule (IF-THEN 30) — never left to Fish's own header default.
 */
function getFishModel(): string {
  return (process.env.FISH_TTS_MODEL || 's2.1-pro').trim();
}

/**
 * Fish's `pcm` output format's default sample rate is not pinned in the
 * public API docs the way Polly's is (Polly: 8000/16000 only, hard error
 * otherwise). This value is REQUESTED, not confirmed — Fish streams raw
 * audio bytes with no rate confirmation in the response. Kept at 16kHz to
 * match the rate every other PCM-format caller in this codebase already
 * expects from a non-Google provider (`POLLY_PCM_SAMPLE_RATE_HZ`), but
 * this is the single highest-priority thing to confirm against a real
 * `cache=hit`-style live response once API credit exists — a silently
 * wrong rate plays audio at the wrong speed exactly like the 24kHz/16kHz
 * mix-up `polly.ts`'s own header warns about.
 */
export const FISH_PCM_SAMPLE_RATE_HZ = 16_000;

const FISH_REQUEST_TIMEOUT_MS = 15_000;

export function isFishFallbackEnabled(): boolean {
  return (process.env.TTS_FISH_FALLBACK_ENABLED || '').trim().toLowerCase() === 'true';
}

/**
 * The flag ALONE is not enough to actually serve a request — `FISH_API_KEY`
 * must be set too. Callers deciding ELIGIBILITY (e.g. the cascade gate)
 * must use this, not `isFishFallbackEnabled()` alone, or they will report a
 * language as servable that `synthesizeFish()` immediately refuses at
 * runtime for the missing key — the same "flag on, adapter unconfigured,
 * still silently serves the fallback" bug CLAUDE.md's Bedrock IF-THEN 31
 * exists to prevent, here for Fish instead of Bedrock.
 */
export function isFishConfigured(): boolean {
  return isFishFallbackEnabled() && !!process.env.FISH_API_KEY;
}

export interface FishSynthesisResult {
  audioB64: string;
  sampleRateHz: number;
  voice: string;
  languageCode: string;
}

/**
 * Synthesize `text` via Fish Audio. Returns null whenever Fish cannot (or
 * should not, per config) serve the request — never throws — so callers
 * keep the same "null means fall back / degrade" contract every other
 * provider in this directory uses.
 */
export async function synthesizeFish(opts: {
  text: string;
  lang: string;
  format: 'mp3' | 'pcm';
}): Promise<FishSynthesisResult | null> {
  const { text, lang, format } = opts;
  if (!text || text.trim().length === 0) return null;

  if (!isFishFallbackEnabled()) {
    return null; // Deploying this file changes nothing until explicitly opted in.
  }

  const apiKey = process.env.FISH_API_KEY;
  if (!apiKey) {
    console.warn('[FISH] TTS_FISH_FALLBACK_ENABLED=true but FISH_API_KEY is unset — skipping.');
    return null;
  }

  const voice = resolveFishVoice(lang);
  if (!voice) {
    // Not every unsupported-by-Polly language has a curated Fish voice yet —
    // that is an explicit, growable gap (see FISH_VOICES), not a bug.
    console.warn(`[FISH] No curated Fish voice for lang='${lang}' — caller must fall back.`);
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FISH_REQUEST_TIMEOUT_MS);

  try {
    const body: Record<string, unknown> = {
      text,
      reference_id: voice.referenceId,
      format,
      normalize: true,
      latency: 'normal',
    };
    if (format === 'pcm') {
      body.sample_rate = FISH_PCM_SAMPLE_RATE_HZ;
    }

    const res = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        model: getFishModel(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Fish returns a JSON error body even on failure (402 credit, 401 auth,
      // 503 overloaded) — log it verbatim rather than just the status code,
      // it names the actual cause (CLAUDE.md: "never silence errors").
      const errBody = await res.text().catch(() => '');
      console.warn(`[FISH] Synthesis failed (lang=${lang}, status=${res.status}): ${errBody}`);
      return null;
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes || bytes.length === 0) return null;

    return {
      audioB64: Buffer.from(bytes).toString('base64'),
      sampleRateHz: format === 'pcm' ? FISH_PCM_SAMPLE_RATE_HZ : 44_100,
      voice: voice.label,
      languageCode: lang,
    };
  } catch (err) {
    console.warn(`[FISH] Synthesis request failed (lang=${lang}, format=${format}):`, (err as Error).message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
