/**
 * VTID-03495 — Amazon Polly TTS provider.
 *
 * First of the four provider replacements that must exist before a GCP
 * shutdown is possible (Polly → Titan image gen → Bedrock vision/tool-calling
 * → Nova Sonic promotion). This module is the Polly half; provider SELECTION
 * lives in `tts-provider.ts` and is gated on `TTS_PROVIDER`, default `google`.
 * Importing this file changes nothing on its own.
 *
 * Three things about Polly differ materially from Google Cloud TTS and are
 * handled explicitly here rather than papered over:
 *
 * 1. **PCM sample rate.** Cloud TTS will emit LINEAR16 at any rate; the
 *    greeting bridge asks for 24kHz. Polly's `pcm` output format supports
 *    ONLY 8000 and 16000 Hz. We emit 16000 and report it back to the caller
 *    so the `audio/pcm;rate=` mime the widget reads stays truthful — the rate
 *    is negotiated, never assumed (see `orb-live.ts` ~L8966).
 *
 * 2. **Speaking rate.** Cloud TTS takes `speakingRate` as a request field.
 *    Polly has no equivalent — rate is expressed via SSML `<prosody rate>`,
 *    so any non-1.0 rate forces `TextType: 'ssml'` and the input text must be
 *    XML-escaped. At rate 1.0 we send plain text and skip SSML entirely.
 *
 * 3. **Serbian is not supported by Polly at all.** Cloud TTS has
 *    `sr-RS-Standard-A`; Polly has no Serbian voice in any engine. `sr` is a
 *    live locale for this platform (CLAUDE.md §13b lists DE/EN/ES/SR), so
 *    this is a real coverage regression, not a rounding error. Rather than
 *    silently substituting another language's voice — which would emit
 *    confident, fluent, WRONG-language audio to a Serbian user —
 *    `resolvePollyVoice()` returns null for `sr` and the caller falls back to
 *    Google (or degrades to no audio if Google is gone). See
 *    `POLLY_UNSUPPORTED_LANGS`.
 *
 * Voice/engine pairs below are pinned per-language. `Engine` is always sent
 * explicitly, satisfying CLAUDE.md's "IF TTS is used → THEN specify
 * model_name explicitly" rule — Polly's `Engine` is that knob.
 *
 * NOTE: the voice/engine table and the Serbian gap were derived from Polly's
 * documented voice list, NOT verified against the live API — this session had
 * no working AWS credentials. `scripts/tts/verify-polly-voices.ts` exists to
 * confirm both against `DescribeVoices` before anyone flips `TTS_PROVIDER`.
 */

import {
  PollyClient,
  SynthesizeSpeechCommand,
  type Engine,
  type OutputFormat,
  type VoiceId,
} from '@aws-sdk/client-polly';

export interface PollyVoiceConfig {
  /** Polly VoiceId, e.g. 'Vicki'. */
  voiceId: VoiceId;
  /** Explicit engine — never left to Polly's default. */
  engine: Engine;
  /** Polly language code, for logging/telemetry parity with Cloud TTS. */
  languageCode: string;
}

/**
 * Languages this platform speaks that Polly cannot. Kept as an explicit,
 * named constant so the gap is greppable rather than an absence in a table.
 */
export const POLLY_UNSUPPORTED_LANGS: ReadonlySet<string> = new Set(['sr']);

/**
 * Language → Polly voice. Female voices throughout, matching the existing
 * Cloud TTS selections (Neural2-F / Kore).
 *
 * `ru` is standard-engine only — Polly has no neural Russian voice. That is a
 * quality step down from `ru-RU-Wavenet-A`, flagged rather than hidden.
 */
const POLLY_VOICES: Record<string, PollyVoiceConfig> = {
  en: { voiceId: 'Joanna' as VoiceId, engine: 'neural' as Engine, languageCode: 'en-US' },
  de: { voiceId: 'Vicki' as VoiceId, engine: 'neural' as Engine, languageCode: 'de-DE' },
  fr: { voiceId: 'Lea' as VoiceId, engine: 'neural' as Engine, languageCode: 'fr-FR' },
  es: { voiceId: 'Lucia' as VoiceId, engine: 'neural' as Engine, languageCode: 'es-ES' },
  ar: { voiceId: 'Hala' as VoiceId, engine: 'neural' as Engine, languageCode: 'ar-AE' },
  zh: { voiceId: 'Zhiyu' as VoiceId, engine: 'neural' as Engine, languageCode: 'cmn-CN' },
  ru: { voiceId: 'Tatyana' as VoiceId, engine: 'standard' as Engine, languageCode: 'ru-RU' },
};

/**
 * Polly's `pcm` OutputFormat accepts only 8000 or 16000 Hz. The greeting
 * bridge's Cloud TTS path uses 24000; callers must read the rate off the
 * synthesis result rather than assuming either value.
 */
export const POLLY_PCM_SAMPLE_RATE_HZ = 16_000;

export function normalizeLang(input: string): string {
  return (input || 'en').toLowerCase().split(/[-_]/)[0].slice(0, 2) || 'en';
}

/**
 * Resolve a Polly voice for `lang`, or null when Polly cannot serve it.
 *
 * Returns null (rather than an English fallback) for unsupported languages
 * on purpose: emitting fluent audio in the wrong language is a worse failure
 * than emitting none, because it is not self-evidently broken to the caller.
 */
export function resolvePollyVoice(lang: string): PollyVoiceConfig | null {
  const normalized = normalizeLang(lang);
  if (POLLY_UNSUPPORTED_LANGS.has(normalized)) return null;
  return POLLY_VOICES[normalized] ?? POLLY_VOICES['en'];
}

/** XML-escape text destined for an SSML payload. */
export function escapeSsml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Wrap `text` in SSML with a prosody rate, or return it unchanged when the
 * rate is effectively 1.0 (Polly is happy with plain text and it avoids a
 * whole class of escaping bugs on the common path).
 */
export function buildPollyInput(
  text: string,
  speakingRate: number,
): { text: string; textType: 'text' | 'ssml' } {
  const rate = Number.isFinite(speakingRate) && speakingRate > 0 ? speakingRate : 1;
  if (Math.abs(rate - 1) < 0.01) return { text, textType: 'text' };
  const pct = Math.round(rate * 100);
  return {
    text: `<speak><prosody rate="${pct}%">${escapeSsml(text)}</prosody></speak>`,
    textType: 'ssml',
  };
}

let pollyClient: PollyClient | null = null;

/**
 * Region resolution mirrors the Bedrock adapter's precedence
 * (CLAUDE.md §2b): explicit override → generic AWS region → eu-central-1,
 * the only region with Vitana AWS infrastructure.
 */
export function getPollyRegion(): string {
  return process.env.AWS_POLLY_REGION || process.env.AWS_REGION || 'eu-central-1';
}

function getPollyClient(): PollyClient {
  if (!pollyClient) {
    pollyClient = new PollyClient({ region: getPollyRegion() });
  }
  return pollyClient;
}

/** Test seam — drop the memoized client so a new region/credential set applies. */
export function resetPollyClientForTests(): void {
  pollyClient = null;
}

export interface PollySynthesisResult {
  /** Base64 audio. For 'pcm' this is headerless LINEAR16 (Polly sends no WAV header). */
  audioB64: string;
  /** Actual sample rate of the returned audio — authoritative, never assumed. */
  sampleRateHz: number;
  /** Voice actually used, for telemetry parity with the Cloud TTS path. */
  voice: string;
  engine: string;
  languageCode: string;
}

/**
 * Synthesize `text` via Polly.
 *
 * Returns null when Polly cannot serve the request (unsupported language,
 * missing credentials, API error) so every caller keeps the same
 * "null means fall back / degrade" contract the Cloud TTS helpers already use.
 */
export async function synthesizePolly(opts: {
  text: string;
  lang: string;
  format: 'mp3' | 'pcm';
  speakingRate?: number;
}): Promise<PollySynthesisResult | null> {
  const { text, lang, format } = opts;
  if (!text || text.trim().length === 0) return null;

  const voice = resolvePollyVoice(lang);
  if (!voice) {
    console.warn(
      `[POLLY] No Polly voice for lang='${normalizeLang(lang)}' ` +
        `(unsupported: ${[...POLLY_UNSUPPORTED_LANGS].join(',')}) — caller must fall back.`,
    );
    return null;
  }

  const { text: input, textType } = buildPollyInput(text, opts.speakingRate ?? 1);
  // Polly rejects SSML on some standard-engine voices' newer features; the
  // prosody tag used here is supported on both engines, so no branch needed.
  const sampleRateHz = format === 'pcm' ? POLLY_PCM_SAMPLE_RATE_HZ : 24_000;

  try {
    const res = await getPollyClient().send(
      new SynthesizeSpeechCommand({
        Text: input,
        TextType: textType,
        VoiceId: voice.voiceId,
        Engine: voice.engine,
        LanguageCode: voice.languageCode as never,
        OutputFormat: format as OutputFormat,
        SampleRate: String(sampleRateHz),
      }),
    );

    if (!res.AudioStream) return null;
    // AudioStream is a stream in Node; the SDK exposes transformToByteArray().
    const bytes = await (
      res.AudioStream as unknown as { transformToByteArray(): Promise<Uint8Array> }
    ).transformToByteArray();
    if (!bytes || bytes.length === 0) return null;

    return {
      audioB64: Buffer.from(bytes).toString('base64'),
      sampleRateHz,
      voice: String(voice.voiceId),
      engine: String(voice.engine),
      languageCode: voice.languageCode,
    };
  } catch (err) {
    console.warn(`[POLLY] Synthesis failed (lang=${lang}, format=${format}):`, (err as Error).message);
    return null;
  }
}
