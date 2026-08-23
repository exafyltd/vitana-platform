/**
 * VTID-03683: configuration + language gate for the CASCADED voice pipeline
 * (Amazon Transcribe → Bedrock → Amazon Polly).
 *
 * WHY THIS PIPELINE EXISTS
 * ------------------------
 * Amazon Nova Sonic — the speech-to-speech model every ORB session runs on
 * since the GCP shutdown — supports exactly `en de fr es pt`
 * (`NOVA_SONIC_SUPPORTED_LANGUAGES`). It cannot speak Russian, Polish,
 * Serbian, Arabic or Chinese at all.
 *
 * Those languages reach it anyway. `upstream-provider-selector.ts` reads:
 *
 *     if (languageBlocked && !vertexDead) → pin to Vertex
 *
 * and since `VERTEX_LIVE_UNAVAILABLE=true` (Vertex Live died with GCP), the
 * language gate is SKIPPED and the session is forced onto Nova regardless —
 * the deliberate VTID-03649 tradeoff of degraded speech over a guaranteed
 * connection failure to a dead endpoint.
 *
 * Measured on production over 14 days, `turn_complete` audio_out per turn:
 *
 *     de 173.0   en 160.7      <- Nova supports these
 *     sr  38.3   pl  35.5   ru  29.8      <- Nova does NOT
 *
 * A 4-5x shortfall landing on exactly the three unsupported languages, and
 * NOT explained by the voice — all five resolve to `tina` (VTID-03682).
 *
 * WHY A CASCADE RATHER THAN "FIX NOVA"
 * ------------------------------------
 * There is no fix. Nova does not speak these languages; no configuration
 * makes it. The cascade decomposes the one thing Nova does atomically
 * (speech → speech) into three steps that each DO support them:
 *
 *     Transcribe (speech → text) → Bedrock (text → text) → Polly (text → speech)
 *
 * This is strictly worse than speech-to-speech on latency and prosody, which
 * is exactly why it is scoped to languages that today get nothing usable.
 * A language Nova speaks must NEVER be routed here.
 */

import type { LanguageCode } from '@aws-sdk/client-transcribe-streaming';
import { resolvePollyVoice } from '../../../services/tts/polly';
import { isNovaSonicLanguageSupported } from './nova-sonic-config';

/**
 * Amazon Transcribe streaming language codes, keyed by our base language.
 *
 * Deliberately a small explicit table rather than `${lang}-${REGION}`
 * guesswork: Transcribe rejects an unknown `LanguageCode` outright, and
 * Chinese is `zh-CN` while Polly's Mandarin voice is `cmn-CN` — the two
 * services do not agree on the tag, so a derived code would be wrong for
 * precisely the language least likely to be spot-checked.
 */
// Typed as the SDK's own `LanguageCode` union, not `string`, so the compiler
// verifies every code here is one Transcribe actually accepts. A typo'd code
// is otherwise a runtime `BadRequestException` with an opaque message, on the
// one path nobody exercises in dev.
const TRANSCRIBE_LANGUAGE_CODES: Record<string, LanguageCode> = {
  en: 'en-US',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
  pt: 'pt-BR',
  ru: 'ru-RU',
  pl: 'pl-PL',
  zh: 'zh-CN',
  // Polly's Arabic voice (Hala) is ar-AE; Transcribe's Gulf Arabic is also
  // ar-AE, so these agree. Modern Standard (ar-SA) exists on Transcribe but
  // has no matching Polly neural voice, so pairing them would put a Gulf
  // voice on MSA transcription for no gain.
  ar: 'ar-AE',
  // `sr-RS` IS a real Transcribe streaming language code — verified against the
  // SDK's own `LanguageCode` union, not assumed. It is listed here deliberately
  // even though `sr` can never be eligible, because it makes the refusal REASON
  // demonstrably true rather than accidentally true: Serbian is blocked solely
  // because Polly has no Serbian voice in any engine (VTID-03578), and with the
  // row present that is what the gate reports. Omitting it would have produced
  // the same refusal for the wrong stated reason, sending the next person to fix
  // Transcribe coverage that was never missing.
  sr: 'sr-RS',
};

/** Base-language normalisation, matching every other table in this codebase. */
export function normalizeCascadeLang(lang: string | null | undefined): string {
  return (lang || '').trim().toLowerCase().split(/[-_]/)[0];
}

/** The Transcribe streaming `LanguageCode` for a language, or null. */
export function resolveTranscribeLanguageCode(lang: string | null | undefined): LanguageCode | null {
  const base = normalizeCascadeLang(lang);
  return TRANSCRIBE_LANGUAGE_CODES[base] ?? null;
}

export type CascadeIneligibilityReason =
  /** Nova speaks this language natively — speech-to-speech is strictly better. */
  | 'nova_supports_natively'
  /** Amazon Transcribe has no streaming language code wired for it. */
  | 'no_transcribe_language'
  /** Amazon Polly has no voice for it in any engine (this is `sr`). */
  | 'no_polly_voice';

export interface CascadeEligibility {
  eligible: boolean;
  reason: CascadeIneligibilityReason | null;
  transcribeLanguageCode: LanguageCode | null;
}

/**
 * Decide whether a language should be served by the cascade.
 *
 * FAILS CLOSED, and the order of the checks is the design:
 *
 *  1. If Nova speaks it, the cascade is refused even though it would
 *     technically work. Routing `de` here would trade a working
 *     speech-to-speech session for a slower three-hop one — a regression
 *     wearing a fix's clothes.
 *  2. Both downstream services must independently answer for the language.
 *     Eligibility is DERIVED from `resolvePollyVoice()` rather than restated
 *     as a second hardcoded list, so a Polly coverage change cannot silently
 *     disagree with this gate. That divergence is exactly what VTID-03681
 *     found across seven tables, and what VTID-03578 found when `pt`/`pl`
 *     were in neither Polly table and fell through to English.
 *
 * `sr` is the one language this pipeline CANNOT rescue: Polly has no Serbian
 * voice in any engine, so it reports `no_polly_voice` and remains a known,
 * named product gap rather than being quietly served in the wrong language.
 * Serbian therefore still has NO working ORB voice after this change — the
 * cascade narrows the outage from five languages to one, it does not close it.
 */
export function evaluateCascadeEligibility(lang: string | null | undefined): CascadeEligibility {
  const base = normalizeCascadeLang(lang);

  if (isNovaSonicLanguageSupported(base)) {
    return { eligible: false, reason: 'nova_supports_natively', transcribeLanguageCode: null };
  }

  // Polly is checked BEFORE Transcribe, and the order is about the honesty of
  // the REASON, not about short-circuit cost. Polly coverage is read from the
  // live `resolvePollyVoice()` table in this repo, so `no_polly_voice` is a
  // fact. `TRANSCRIBE_LANGUAGE_CODES` is a table written here and NOT verified
  // against the live Transcribe API, so `no_transcribe_language` means "we did
  // not wire it", which is weaker. Checking Transcribe first made `sr` — whose
  // real, verified blocker is that Polly has no Serbian voice in any engine —
  // report `no_transcribe_language`, attributing the gap to the table we are
  // least sure about. A reason that names the wrong service sends the next
  // person to fix the wrong thing.
  if (!resolvePollyVoice(base)) {
    return { eligible: false, reason: 'no_polly_voice', transcribeLanguageCode: null };
  }

  const transcribeLanguageCode = resolveTranscribeLanguageCode(base);
  if (!transcribeLanguageCode) {
    return { eligible: false, reason: 'no_transcribe_language', transcribeLanguageCode: null };
  }

  return { eligible: true, reason: null, transcribeLanguageCode };
}

/** Convenience predicate for call sites that do not need the reason. */
export function isCascadeLanguageSupported(lang: string | null | undefined): boolean {
  return evaluateCascadeEligibility(lang).eligible;
}

/**
 * Activation gate. Default OFF — deploying this code changes no routing.
 *
 * Exact-string `'true'`, matching `NOVA_SONIC_GLOBAL_ENABLED`'s convention,
 * so a typo'd value is off rather than truthy.
 */
export function isCascadeEnabled(): boolean {
  return (process.env.ORB_CASCADED_VOICE_ENABLED || '').trim() === 'true';
}

/** Region for Transcribe streaming (own var, then the shared AWS region). */
export function resolveTranscribeRegion(): string {
  return (
    process.env.AWS_TRANSCRIBE_REGION ||
    process.env.AWS_REGION ||
    'eu-central-1'
  );
}

/**
 * The languages this pipeline currently rescues, for health/telemetry output.
 * Computed, never hand-maintained — a list that can drift from the predicate
 * is a list that will.
 */
export function listCascadeLanguages(): string[] {
  return Object.keys(TRANSCRIBE_LANGUAGE_CODES).filter((l) => isCascadeLanguageSupported(l));
}
