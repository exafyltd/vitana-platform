/**
 * VTID-03641 — languages with NO native speech-to-speech voice on either
 * upstream provider.
 *
 * Nova Sonic only speaks `NOVA_SONIC_SUPPORTED_LANGUAGES` (en/de/fr/es).
 * Vertex/Gemini Live's fallback voice map (`VERTEX_VOICE_FALLBACK_LANGUAGES`)
 * covers a wider set, but not all live locales — `pt` and `pl` are in
 * neither, which is why picking either one on ORB Live silently answered the
 * user in fluent English (Vertex's `getLiveLanguageVoice` falls back to the
 * `en` voice when a language has no row).
 *
 * The platform owner's standing direction (2026-08-13, alongside VTID-03642)
 * is explicit: never patch this class of gap by routing the session to
 * Vertex. Use Amazon Polly to synthesize speech instead — see `nova-sonic`
 * wiring in `upstream-message-handler.ts` for where this predicate gates
 * suppressing Nova's own (wrong-language) audio output and substituting a
 * Polly-synthesized turn.
 *
 * Deliberately a PURE, synchronous predicate over two static language sets —
 * not a DB read — because it feeds `upstream-provider-selector.ts`, whose
 * own contract is "never reads env / DB / OASIS". Basing it on the two
 * existing static language lists (rather than hardcoding `['pt','pl']`)
 * means a future language added to the picker with no voice wired anywhere
 * automatically gets the Polly-only treatment instead of silently inheriting
 * Vertex's English fallback — this closes the whole CLASS of bug, not just
 * today's two instances.
 */

import { NOVA_SONIC_SUPPORTED_LANGUAGES } from '../upstream/nova-sonic-config';
import { VERTEX_VOICE_FALLBACK_LANGUAGES } from './voice-mapping';

/** Case-insensitive, base-tag match — mirrors `isNovaSonicLanguageSupported`. */
function baseTag(lang: string | undefined | null): string {
  if (!lang) return '';
  return lang.trim().toLowerCase().split(/[-_]/)[0];
}

/**
 * True when `lang` has no native speech voice on Nova Sonic AND no fallback
 * voice on Vertex/Gemini Live — i.e. the only way to speak a reply in this
 * language is text-to-speech synthesis (Polly), never a provider's own voice.
 */
export function needsPollyOnlyVoice(lang: string | undefined | null): boolean {
  const base = baseTag(lang);
  if (!base) return false;
  if ((NOVA_SONIC_SUPPORTED_LANGUAGES as readonly string[]).includes(base)) return false;
  if (VERTEX_VOICE_FALLBACK_LANGUAGES.has(base)) return false;
  return true;
}
