/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (Task 3): application language → Nova 2 Sonic
 * voice ID mapping.
 *
 * Nova has its OWN voice catalog — Gemini voice IDs (`Kore`, `Charon`,
 * `Aoede`, …) must never be passed to Nova. The ones this file names are:
 *   en → amy   (VTID-03809 — user live-test verdict 2026-07-28 rejected en's
 *               native `tiffany` and settled on `tina` (Nova's DE voice)
 *               reused for EN, at the cost of a German accent on English
 *               speech. A later listener disliked that German-accented
 *               English and asked for an alternative; `amy` — Nova 2 Sonic's
 *               native en-GB voice, confirmed in AWS's own Nova 2 voice
 *               catalog docs — is untried in this app and swaps the German
 *               accent for a British one instead. `tiffany`/`matthew` (en-US)
 *               were not reconsidered: tiffany already lost the 07-28 test,
 *               and matthew is masculine, excluded by the VTID-03704
 *               female-only rule below. Needs the same kind of live listen
 *               `tina` got before this is treated as final.)
 *   de → tina
 *   fr → ambre
 *   es → lupe
 *
 * VTID-04445 — VITANA FEMALE, DEVON MALE, EVERY LANGUAGE.
 * -------------------------------------------------------
 * Owner rule 2026-09-23 (`persona-voice-gender.ts`): every Vitana voice is a
 * woman's voice and every Devon voice is a man's voice. `NOVA_VOICES` below
 * is Vitana's table; `NOVA_MALE_VOICES` is Devon's. The persona that is
 * speaking selects the table — only a persona the rule marks `male` (Devon)
 * reaches the male table, so everyone else keeps Vitana's female voice.
 *
 * VTID-03704 had removed the split (Devon spoke with Vitana's female voice on
 * every Nova session). Its reason still holds and is kept: the voice must not
 * differ across the sign-in boundary. It no longer can — the persona is not
 * carried across sessions; `activePersona` is only ever set by a hand-off
 * inside one session, and a new session always starts as Vitana.
 *
 * The male ids are AWS's own masculine voice per locale (Nova 2 user guide,
 * "Language support"), each invoked for real on Bedrock and pitch-checked —
 * see `NOVA_VOICE_GENDER`.
 *
 * `pt` is ROUTED to the Polly cascade (Nova answered a live Portuguese
 * session in English — see `nova-sonic-config.ts`) but KEEPS its Nova voice
 * entry here, `carolina`. Routing and voice are separate questions; see the
 * note on `resolveNovaSonicVoice` for why collapsing them regressed `pt` to a
 * German voice.
 *
 * VTID-03803 — `fr`/`es` join `pt` on the same routing/voice
 * split for the identical reason (reported live: Spanish/French Orb
 * conversation answering in English). Both KEEP their Nova voice entries
 * (`ambre`/`lupe`) here for the same reason `pt` kept `carolina`.
 *
 * A `null` result means Nova publishes no voice for the language at all
 * (`ru`/`pl`/`ar`/`zh`/`sr`). That is a real runtime path, not a
 * programming error: `sr` stays on Nova permanently because Polly has no
 * Serbian voice in any engine, and the rest reach it whenever the cascade is
 * switched off. `resolveNovaSonicVoiceOrFallback` is what callers use, and it
 * reports the substitution rather than hiding it.
 */

import { personaVoiceGender } from './persona-voice-gender';

const NOVA_VOICES = {
  en: 'amy',
  de: 'tina',
  fr: 'ambre',
  es: 'lupe',
  // pt is NOT in `NOVA_SONIC_SUPPORTED_LANGUAGES` — it routes to the Polly
  // cascade. It is still in THIS table on purpose; see the note on
  // `resolveNovaSonicVoice` about why routing and voice are separate
  // questions. `carolina` is Nova 2's pt-BR feminine voice, confirmed by a
  // real bidirectional stream under VTID-03672 (Bedrock accepts it and
  // rejects a deliberately bogus id with `Received invalid id`, which is what
  // makes acceptance evidence rather than absence of an error). pt-BR also
  // matches this app's Portuguese catalog (VTID-03577).
  pt: 'carolina',
} as const;

/**
 * VTID-04445 — Devon's Nova voice per language: AWS's masculine voice for the
 * same locale (`en` is en-US `matthew`: en-GB has no masculine Nova voice).
 */
const NOVA_MALE_VOICES = {
  en: 'matthew',
  de: 'lennart',
  fr: 'florian',
  es: 'carlos',
  pt: 'leo',
} as const;

export type NovaSonicVoiceId =
  | (typeof NOVA_VOICES)[keyof typeof NOVA_VOICES]
  | (typeof NOVA_MALE_VOICES)[keyof typeof NOVA_MALE_VOICES];

/** True when the speaking persona must use a male voice (Devon). */
function wantsMaleVoice(persona: string | null | undefined): boolean {
  return personaVoiceGender(persona) === 'male';
}

/** Test/verification seam: both tables, read-only. */
export function listNovaSonicVoices(): {
  female: Readonly<Record<string, string>>;
  male: Readonly<Record<string, string>>;
} {
  return { female: NOVA_VOICES, male: NOVA_MALE_VOICES };
}

export interface NovaSonicVoiceQuery {
  /** Application language (BCP-47 tag or bare code; base tag is used). */
  language: string;
  /** Active persona key (`vitana`, `devon`, `sage`, `atlas`, `mira`). */
  persona?: string | null;
}

/**
 * Resolve the Nova voice for a language. Returns `null` when Nova publishes
 * no voice for it at all.
 *
 * VTID-03704 — THIS DOES NOT GATE ON `isNovaSonicLanguageSupported()`, and
 * that is the whole point of the function.
 *
 * Routing and voice answer different questions:
 *
 *   - `NOVA_SONIC_SUPPORTED_LANGUAGES` decides WHERE a session goes. `pt` is
 *     not in it, so `pt` is routed to the Polly cascade.
 *   - This table decides WHICH VOICE Nova uses if it ends up carrying the
 *     language anyway.
 *
 * The second case is not hypothetical. `tryCascadeRescue()`
 * (`upstream-provider-selector.ts`) returns null whenever
 * `ORB_CASCADED_VOICE_ENABLED` is not exactly `'true'`, and control falls
 * through to `nova_forced_vertex_unavailable` — Nova is forced to carry the
 * language rather than connect to dead Vertex. So between this code landing
 * and the cascade's IAM being granted, every `pt` session still transits
 * Nova.
 *
 * Sharing the routing guard here meant `pt` resolved to `null` and took the
 * `tina` fallback — a GERMAN voice reading Brazilian Portuguese, strictly
 * worse than the `carolina` it had before, i.e. a regression introduced by
 * the fix. A voice table that silently empties itself when a language is
 * rerouted is the failure this codebase has already paid for twice
 * (VTID-03578's `?? POLLY_VOICES['en']`, VTID-03682's bare `??`).
 *
 * `ru`/`pl`/`ar`/`zh`/`sr` are absent because Nova genuinely publishes no
 * voice for them — they still resolve `null` and take the documented
 * substitution, unchanged.
 */
export function resolveNovaSonicVoice(query: NovaSonicVoiceQuery): NovaSonicVoiceId | null {
  const base = query.language.trim().toLowerCase().split(/[-_]/)[0] as keyof typeof NOVA_VOICES;
  // VTID-04445 — the speaking persona picks the table: Devon male, everyone
  // else Vitana's female voice. Both tables cover the same languages.
  const voice = wantsMaleVoice(query.persona) ? NOVA_MALE_VOICES[base] : NOVA_VOICES[base];
  return voice ?? null;
}

/**
 * VTID-03682 — the house voice used when a language has NO native Nova voice.
 *
 * `tina` is Nova's GERMAN voice. Substituting it for Russian, Polish or
 * Serbian is a real compromise, and it is chosen deliberately rather than
 * inherited: Nova publishes no voice for those languages, so there is nothing
 * better to switch to, and `pl`/`sr` are confirmed working with it in
 * production. `tina` is also `de`'s own native voice (see the header note),
 * so the substitution reuses a voice this product already ships knowingly.
 */
export const NOVA_SONIC_FALLBACK_VOICE: NovaSonicVoiceId = 'tina';

/**
 * VTID-04445 — Devon's counterpart of `NOVA_SONIC_FALLBACK_VOICE`: `lennart`,
 * the masculine voice of the same German locale, so a language with no native
 * Nova voice gets the same accent compromise for both personas and Devon
 * never falls back to Vitana's female voice.
 */
export const NOVA_SONIC_MALE_FALLBACK_VOICE: NovaSonicVoiceId = 'lennart';

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
  if (native !== null) return { voice: native, fallback: false };
  return {
    voice: wantsMaleVoice(query.persona) ? NOVA_SONIC_MALE_FALLBACK_VOICE : NOVA_SONIC_FALLBACK_VOICE,
    fallback: true,
  };
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
