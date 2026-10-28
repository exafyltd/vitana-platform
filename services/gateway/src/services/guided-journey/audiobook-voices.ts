/**
 * VTID-05026 — the Audiobook narration voice table, one entry per language.
 *
 * Audiobook-only. The receptionist table (`POLLY_VOICES` in `tts/polly.ts`)
 * still serves every other Polly caller and is not changed; this table only
 * decides who reads a My Journey episode. Every voice is a woman's voice
 * (CLAUDE.md 42a), pinned by `vtid-04445-persona-voice-gender.test.ts`.
 *
 * Owner decisions (2026-10-05, plan-sparring.md Version 2):
 *   - en Tiffany, de Vicki, fr Ambre, es Lucia, pt Camila, pl Ola — Polly
 *     `generative`. Verified live 2026-10-10 (DescribeVoices, eu-central-1):
 *     each is Female and lists `generative`.
 *   - ar Hala, zh Zhiyu, tr Burcu — Polly `neural`, unchanged.
 *   - ru and sr — Google, each behind its own switch
 *     (`audiobook-google-ru.ts`, `audiobook-google-sr.ts`). Voice: Chirp 3 HD
 *     Aoede in both languages — the same Vitana voice across the two, female
 *     per Google's own `voices.list` (`ssmlGender: FEMALE`, read 2026-10-10).
 *     The owner delegated the pick on 2026-10-10; the alternatives are
 *     listed by `GET /api/v1/voice/preview/google-voices`. Chirp 3 HD voices
 *     take no `model_name` (only Gemini-TTS voices do).
 *
 * Google is off unless BOTH its language switch is on AND the per-task daily
 * character cap is a positive number (`audiobook-google-budget.ts`). Off,
 * Russian keeps Polly Tatyana (`standard`, the only Russian Polly voice) and
 * Serbian has no voice (the route answers 422). There is no fallback from a
 * failed or capped Google render to any other voice.
 */

import type { Engine, VoiceId } from '@aws-sdk/client-polly';
import { normalizeLang, type PollyVoiceConfig } from '../tts/polly';
import type { GoogleNarrationVoice } from '../tts/google-narration';
import { isAudiobookGoogleRuEnabled } from './audiobook-google-ru';
import { isAudiobookGoogleSrEnabled } from './audiobook-google-sr';
import { readAudiobookGoogleDailyCap } from './audiobook-google-budget';

export type AudiobookVoice =
  | ({ provider: 'polly' } & PollyVoiceConfig)
  | ({ provider: 'google' } & GoogleNarrationVoice);

const polly = (voiceId: string, engine: string, languageCode: string): AudiobookVoice => ({
  provider: 'polly',
  voiceId: voiceId as VoiceId,
  engine: engine as Engine,
  languageCode,
});

/** The nine Polly languages. */
export const AUDIOBOOK_POLLY_VOICES: Readonly<Record<string, AudiobookVoice>> = {
  en: polly('Tiffany', 'generative', 'en-US'),
  de: polly('Vicki', 'generative', 'de-DE'),
  fr: polly('Ambre', 'generative', 'fr-FR'),
  es: polly('Lucia', 'generative', 'es-ES'),
  pt: polly('Camila', 'generative', 'pt-BR'),
  pl: polly('Ola', 'generative', 'pl-PL'),
  ar: polly('Hala', 'neural', 'ar-AE'),
  zh: polly('Zhiyu', 'neural', 'cmn-CN'),
  tr: polly('Burcu', 'neural', 'tr-TR'),
};

/** Russian when its Google switch is off: Polly has nothing better (standard only). */
export const AUDIOBOOK_RU_POLLY_VOICE: AudiobookVoice = polly('Tatyana', 'standard', 'ru-RU');

/**
 * The Google voices, ru and sr only. `null` would mean "not pinned yet":
 * with the switch on, sr then answers 422 and ru keeps Polly.
 */
export const AUDIOBOOK_GOOGLE_VOICES: Readonly<{ ru: GoogleNarrationVoice | null; sr: GoogleNarrationVoice | null }> = {
  ru: { name: 'ru-RU-Chirp3-HD-Aoede', languageCode: 'ru-RU', modelName: null },
  sr: { name: 'sr-RS-Chirp3-HD-Aoede', languageCode: 'sr-RS', modelName: null },
};

/**
 * The voice that reads an Audiobook episode in `lang`, or null when no voice
 * may read it (the route answers 422 narration_unavailable).
 */
export function resolveAudiobookVoice(
  lang: string,
  env: NodeJS.ProcessEnv = process.env,
): AudiobookVoice | null {
  const n = normalizeLang(lang);
  const googleBudgetSet = readAudiobookGoogleDailyCap(env) > 0;
  if (n === 'ru') {
    const v = AUDIOBOOK_GOOGLE_VOICES.ru;
    if (v && googleBudgetSet && isAudiobookGoogleRuEnabled(env)) return { provider: 'google', ...v };
    return AUDIOBOOK_RU_POLLY_VOICE;
  }
  if (n === 'sr') {
    const v = AUDIOBOOK_GOOGLE_VOICES.sr;
    if (v && googleBudgetSet && isAudiobookGoogleSrEnabled(env)) return { provider: 'google', ...v };
    return null;
  }
  return AUDIOBOOK_POLLY_VOICES[n] ?? null;
}
