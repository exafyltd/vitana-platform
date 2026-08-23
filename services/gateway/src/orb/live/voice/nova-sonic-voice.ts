/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (Task 3): application language → Nova 2 Sonic
 * voice ID mapping.
 *
 * Nova has its OWN voice catalog — Gemini voice IDs (`Kore`, `Charon`,
 * `Aoede`, …) must never be passed to Nova. The ones this file names are:
 *   en → tina   (user live-test verdict 2026-07-28: en's native `tiffany`
 *                sounded bad; `tina` — Nova's DE voice — sounds good and is
 *                reused for EN content too, at the cost of a German accent
 *                on English speech)
 *   de → tina
 *   fr → ambre
 *   es → lupe
 *
 * VTID-03704 — ONE VOICE PER LANGUAGE, ALWAYS FEMALE.
 * ---------------------------------------------------
 * This map used to be `{ feminine, masculine }` per language, with `devon`
 * and `atlas` selecting the masculine voice. That is gone. Vitana speaks with
 * a female voice in every language, so the persona no longer picks the vocal
 * cords — it still drives the system instruction, tone and tools.
 *
 * The pair-shaped table is removed rather than left half-read: keeping
 * `masculine` keys nothing resolves would be a mechanism that looks live and
 * cannot fire, and the next reader would reasonably assume persona still
 * switches the voice. Nova's masculine ids (`lennart`, `florian`, `carlos`)
 * are recorded here in prose so reinstating the split is a lookup, not a
 * research task.
 *
 * `pt` is no longer listed: Nova answered a live Portuguese session in
 * English, so `pt` now routes to the Polly cascade instead (see
 * `nova-sonic-config.ts`). Its Nova ids were `carolina`/`leo`.
 *
 * Unsupported languages resolve to `null` — callers must already have routed
 * to the cascade before asking for a Nova voice, so `null` is a
 * programming-error signal, not a runtime fallback path. The one language
 * that legitimately reaches the fallback is `sr`: Polly has no Serbian voice
 * in any engine, so Serbian stays on Nova with a substituted voice.
 */

import { isNovaSonicLanguageSupported } from '../upstream/nova-sonic-config';

const NOVA_VOICES = {
  en: 'tina',
  de: 'tina',
  fr: 'ambre',
  es: 'lupe',
} as const;

export type NovaSonicVoiceId = (typeof NOVA_VOICES)[keyof typeof NOVA_VOICES];

export interface NovaSonicVoiceQuery {
  /** Application language (BCP-47 tag or bare code; base tag is used). */
  language: string;
  /** Active persona key (`vitana`, `devon`, `sage`, `atlas`, `mira`). */
  persona?: string | null;
}

/**
 * Resolve the Nova voice for a language + persona. Returns `null` for
 * languages outside the Nova canary set.
 */
export function resolveNovaSonicVoice(query: NovaSonicVoiceQuery): NovaSonicVoiceId | null {
  if (!isNovaSonicLanguageSupported(query.language)) return null;
  const base = query.language.trim().toLowerCase().split(/[-_]/)[0] as keyof typeof NOVA_VOICES;
  const voice = NOVA_VOICES[base];
  if (!voice) return null;
  // VTID-03704 — Vitana speaks with a FEMALE voice in every language, and the
  // persona no longer changes that.
  //
  // This is what made the voice differ across the sign-in boundary, which is
  // how it was reported: an anonymous session has no `activePersona`, so it
  // resolved `vitana` → feminine, while a signed-in user carrying `devon` or
  // `atlas` resolved masculine. Same user, same language, different voice
  // before and after login, with nothing in the telemetry naming the cause
  // (`persona` was not recorded on the session — VTID-03704 adds it).
  //
  // Persona still drives everything else it always did (system instruction,
  // tone, tools). It just no longer picks the vocal cords.
  return voice;
}

/**
 * VTID-03682 — the house voice used when a language has NO native Nova voice.
 *
 * `tina` is Nova's GERMAN voice. Substituting it for Russian, Polish or
 * Serbian is a real compromise, and it is chosen deliberately rather than
 * inherited: Nova publishes no voice for those languages, so there is nothing
 * better to switch to, and `pl`/`sr` are confirmed working with it in
 * production. `tina` is also already the house voice for English (see the
 * header note — the native `tiffany` was rejected on a live listen), so this
 * is the same substitution the product already ships knowingly for `en`.
 */
export const NOVA_SONIC_FALLBACK_VOICE: NovaSonicVoiceId = 'tina';

export interface NovaSonicVoiceResolution {
  voice: NovaSonicVoiceId;
  /**
   * True when the requested language has no native Nova voice and
   * `NOVA_SONIC_FALLBACK_VOICE` was substituted. Callers MUST surface this —
   * see `resolveNovaSonicVoiceOrFallback`'s note.
   */
  fallback: boolean;
}

/**
 * VTID-03682 — resolve a Nova voice, reporting WHETHER a substitution happened.
 *
 * WHY THIS EXISTS RATHER THAN `resolveNovaSonicVoice(...) ?? 'tina'`
 * -----------------------------------------------------------------
 * That `??` is what `routes/orb-live.ts` used, and it is the same shape as two
 * defects this codebase has already paid for:
 *
 *   - VTID-03578: `resolvePollyVoice()` ended `?? POLLY_VOICES['en']`, so
 *     Portuguese and Polish users were read to in fluent ENGLISH by a voice
 *     that logged nothing and returned healthy audio.
 *   - `live-api-voice.ts` hit the same thing and solved it properly, with a
 *     `fallback_lang` field and a one-shot `[voice-fallback]` log. The Nova
 *     path never got that treatment.
 *
 * A bare `??` cannot be observed: the caller gets a valid-looking voice id and
 * has no way to know it is not the right one. Russian and Serbian have been
 * spoken by a German voice in production with no signal anywhere.
 *
 * This deliberately does NOT change which voice is served — see
 * `NOVA_SONIC_FALLBACK_VOICE`. Refusing to resolve would break `pl`/`sr`,
 * which work today. The bug being fixed is the SILENCE, not the choice.
 */
export function resolveNovaSonicVoiceOrFallback(
  query: NovaSonicVoiceQuery,
): NovaSonicVoiceResolution {
  const native = resolveNovaSonicVoice(query);
  return native === null
    ? { voice: NOVA_SONIC_FALLBACK_VOICE, fallback: true }
    : { voice: native, fallback: false };
}

// Dedupe log lines: a per-session resolve must not spam the logger. One
// emission per language per process lifetime, mirroring `live-api-voice.ts`.
const loggedNovaVoiceFallbacks = new Set<string>();

/**
 * Log a Nova voice substitution at most once per language per process.
 * Separate from the resolver so the resolver stays pure and testable.
 */
export function logNovaSonicVoiceFallbackOnce(language: string, voice: string): void {
  const base = (language || '').trim().toLowerCase().split(/[-_]/)[0] || 'unknown';
  if (loggedNovaVoiceFallbacks.has(base)) return;
  loggedNovaVoiceFallbacks.add(base);
  // eslint-disable-next-line no-console
  console.warn(
    `[voice-fallback] nova_sonic: lang="${base}" has no native Nova voice — ` +
      `substituting "${voice}" (German). Speech will carry a German accent.`,
  );
}

/** Test seam: the one-shot latch is process-global by design. */
export function __resetNovaSonicVoiceFallbackLog(): void {
  loggedNovaVoiceFallbacks.clear();
}
