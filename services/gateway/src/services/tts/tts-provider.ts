/**
 * VTID-03495 — TTS provider selection.
 *
 * Single place that decides whether a synthesis request goes to Google Cloud
 * TTS (canonical today) or Amazon Polly. Every one of the four Cloud TTS
 * call sites routes through here so the provider can be changed in ONE place
 * instead of four.
 *
 * ## Default is `google`. Deploying this code flips nothing.
 *
 * `TTS_PROVIDER=polly` is a deliberate, separate operator action — the same
 * shape as `BEDROCK_ROLE_ARN` (CLAUDE.md §2b), `DEV_AUTOPILOT_JOB_CLOUD`
 * (§1b) and `PUBLISH_TARGET_CLOUD` (§8). An unrecognised value falls back to
 * `google` loudly rather than failing closed and taking voice down.
 *
 * ## Fallback semantics
 *
 * With `TTS_PROVIDER=polly`, a request Polly cannot serve (Serbian — see
 * `polly.ts`; or a Polly API error) falls back to Google **unless**
 * `TTS_POLLY_STRICT=true`. The fallback exists because Polly's language
 * coverage is genuinely narrower than Cloud TTS's, and losing a locale's
 * audio outright is worse than a provider split during migration. Set
 * `TTS_POLLY_STRICT=true` in a GCP-shutdown rehearsal to prove there is no
 * hidden Google dependency left — with it on, an unservable request returns
 * null instead of quietly reaching back to GCP.
 *
 * Every fallback is logged. CLAUDE.md forbids silent provider fallback
 * ("Never allow silent model fallback" / "IF model fallback occurs → THEN log
 * explicitly"), and that rule applies here as much as to the LLM router.
 */

import { synthesizePolly, resolvePollyVoice, POLLY_PCM_SAMPLE_RATE_HZ } from './polly';

export type TtsProviderName = 'google' | 'polly';

/** Cloud TTS LINEAR16 rate the greeting bridge has always used. */
export const GOOGLE_PCM_SAMPLE_RATE_HZ = 24_000;

export function getTtsProvider(): TtsProviderName {
  const raw = (process.env.TTS_PROVIDER || 'google').trim().toLowerCase();
  if (raw === 'polly') return 'polly';
  if (raw !== 'google' && raw !== '') {
    console.warn(`[TTS] Unrecognised TTS_PROVIDER='${raw}' — defaulting to 'google'.`);
  }
  return 'google';
}

export function isPollyStrict(): boolean {
  return (process.env.TTS_POLLY_STRICT || '').trim().toLowerCase() === 'true';
}

/**
 * Sample rate the PCM path will actually produce for the active provider.
 * Callers MUST use this (or the rate on the synthesis result) when building
 * an `audio/pcm;rate=` mime — Polly cannot do 24kHz PCM.
 */
export function getPcmSampleRateHz(): number {
  return getTtsProvider() === 'polly' ? POLLY_PCM_SAMPLE_RATE_HZ : GOOGLE_PCM_SAMPLE_RATE_HZ;
}

export interface TtsResult {
  audioB64: string;
  sampleRateHz: number;
  voice: string;
  languageCode: string;
  provider: TtsProviderName;
  /** Set when the request was served by a provider other than the configured one. */
  fellBackFrom?: TtsProviderName;
}

/**
 * Attempt synthesis on Polly. Returns null when Polly is not the configured
 * provider, or cannot serve this request.
 *
 * Callers use this as a "try Polly first, else run your existing Google code"
 * seam, which keeps the Google paths byte-for-byte unchanged when
 * `TTS_PROVIDER` is unset — the safest possible shape for a migration that
 * touches live voice.
 */
export async function tryPollySynthesis(opts: {
  text: string;
  lang: string;
  format: 'mp3' | 'pcm';
  speakingRate?: number;
  /** Call-site label for logs, e.g. 'greeting-bridge'. */
  callSite: string;
}): Promise<TtsResult | null> {
  if (getTtsProvider() !== 'polly') return null;

  const started = Date.now();
  const result = await synthesizePolly({
    text: opts.text,
    lang: opts.lang,
    format: opts.format,
    speakingRate: opts.speakingRate,
  });

  if (result) {
    // CLAUDE.md rule 19: always log provider, model and latency for AI calls.
    console.log(
      `[TTS] provider=polly call_site=${opts.callSite} voice=${result.voice} ` +
        `engine=${result.engine} lang=${result.languageCode} format=${opts.format} ` +
        `rate_hz=${result.sampleRateHz} latency_ms=${Date.now() - started}`,
    );
    return {
      audioB64: result.audioB64,
      sampleRateHz: result.sampleRateHz,
      voice: result.voice,
      languageCode: result.languageCode,
      provider: 'polly',
    };
  }

  const unsupported = resolvePollyVoice(opts.lang) === null;
  if (isPollyStrict()) {
    console.warn(
      `[TTS] provider=polly call_site=${opts.callSite} lang=${opts.lang} FAILED ` +
        `(${unsupported ? 'unsupported_language' : 'synthesis_error'}) and ` +
        `TTS_POLLY_STRICT=true — NOT falling back to Google. No audio returned.`,
    );
    return null;
  }

  // Explicit, never silent (CLAUDE.md: "IF model fallback occurs → THEN log explicitly").
  console.warn(
    `[TTS] FALLBACK polly→google call_site=${opts.callSite} lang=${opts.lang} ` +
      `reason=${unsupported ? 'unsupported_language' : 'synthesis_error'} ` +
      `latency_ms=${Date.now() - started}`,
  );
  return null;
}
