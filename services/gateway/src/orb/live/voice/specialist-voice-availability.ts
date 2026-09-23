/**
 * VTID-04445 — may a persona take over THIS session with a voice that obeys
 * the persona voice-gender rule (`persona-voice-gender.ts`)?
 *
 * Every hand-off site (`report_to_specialist`, `switch_persona`) asks this
 * before queueing a persona swap. Devon may only ever speak with a man's
 * voice; when the session's voice pipeline has none for the language, the
 * hand-off does not happen — the ticket is still filed and Vitana stays with
 * the member (`ticket_filed_no_handoff`), instead of Devon speaking with
 * Vitana's voice.
 *
 * Per pipeline:
 *   - `nova_sonic` — always: every language resolves a male Nova voice
 *     (native, or `lennart` as the no-native-voice fallback).
 *   - `vertex` (Serbian bridge) — always: `enforceVertexVoiceGender()` gives
 *     Devon `Charon` whatever the registry row says.
 *   - `cascaded` — Polly's male voice for the language, or the male Fish
 *     voice when Fish is configured (`resolveCascadeSpecialistVoice`).
 */

import { personaVoiceGender } from './persona-voice-gender';
import { resolveNovaSonicVoiceOrFallback } from './nova-sonic-voice';
import { resolveCascadeSpecialistVoice } from '../upstream/cascaded/tts-backend';

export type PersonaVoiceAvailability =
  | { ok: true; pipeline: string; voice: string | null }
  | { ok: false; pipeline: string; reason: 'no_male_voice_for_language' };

export function personaVoiceAvailability(opts: {
  persona: string | null | undefined;
  lang: string | null | undefined;
  provider: string | null | undefined;
}): PersonaVoiceAvailability {
  const pipeline = (opts.provider || 'unknown').trim();
  const lang = (opts.lang || 'en').trim() || 'en';
  if (personaVoiceGender(opts.persona) !== 'male') return { ok: true, pipeline, voice: null };

  if (pipeline === 'nova_sonic') {
    return { ok: true, pipeline, voice: resolveNovaSonicVoiceOrFallback({ language: lang, persona: opts.persona }).voice };
  }
  if (pipeline === 'cascaded') {
    const voice = resolveCascadeSpecialistVoice(lang);
    return voice
      ? { ok: true, pipeline, voice: voice.voice }
      : { ok: false, pipeline, reason: 'no_male_voice_for_language' };
  }
  // vertex: enforced at setup (enforceVertexVoiceGender). Anything else is
  // not a gateway voice pipeline this module can speak for.
  return { ok: true, pipeline, voice: null };
}
