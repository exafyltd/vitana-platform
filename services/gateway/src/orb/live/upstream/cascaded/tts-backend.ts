/**
 * VTID-03987 — formalizes the TTS-backend boundary inside the cascade.
 *
 * `CascadedLiveClient` owns three things: Transcribe (STT), the turn/
 * silence-gating state machine, and Bedrock (the LLM call). All three are
 * shared, provider-agnostic PIPELINE code — every cascade-eligible language
 * runs through the identical instances of them, whether its TTS ends up
 * being Polly (`ru`/`pl`/`tr`/`zh`/`ar`, live in production today) or Fish
 * (`sr`, opt-in — VTID-03970). Only the final step, turning reply text into
 * audio, legitimately varies per language.
 *
 * Before this file, that distinction was implicit: `runTurn()` called
 * `synthesizePolly()`/`synthesizeFish()` inline, so nothing marked which
 * lines were "safe to touch for Fish-only work" vs "touches every cascade
 * language, including live Polly ones" (raised explicitly by the platform
 * owner after VTID-03986's latency fix touched the same shared file). This
 * module makes that boundary an explicit interface. Behaviour is UNCHANGED —
 * `synthesizeCascadeReply()` below is a straight extraction of the exact
 * sequence `runTurn()` ran inline: Polly first, always; Fish only as a
 * fallback when Polly has no voice for the language at all — never on a
 * transient Polly error.
 *
 * RULE GOING FORWARD:
 *   - A change inside `pollyBackend`/`fishBackend` (which model, voice or
 *     engine a backend uses) is backend-local. Fish work never needs to
 *     touch Polly's backend or vice versa.
 *   - A change to `synthesizeCascadeReply()`'s SELECTION logic, or to
 *     anything in `cascaded-live-client.ts` outside this file (Transcribe,
 *     turn-gating), affects EVERY cascade language and needs a regression
 *     test against a Polly-backed language (e.g. `ru`), not just Fish/`sr`.
 *   - Nova Sonic is a different class entirely (`NovaSonicLiveClient`,
 *     constructed by a separate branch of `upstream-client-factory.ts`'s
 *     switch) and is structurally unreachable from anything in this
 *     directory — nothing here can affect a Nova Sonic session.
 */

import {
  synthesizePolly,
  resolvePollyVoice,
  resolvePollySpecialistVoice,
  type PollyVoiceRole,
} from '../../../../services/tts/polly';
import { synthesizeFish, resolveFishVoice } from '../../../../services/tts/fish';

export interface CascadeTtsResult {
  audioB64: string;
}

/**
 * VTID-04336 — which persona is speaking. Omitted = receptionist (Vitana),
 * the exact pre-VTID-04336 request for every backend.
 */
export interface CascadeTtsOptions {
  voiceRole?: PollyVoiceRole;
}

export interface CascadeTtsBackend {
  readonly name: 'polly' | 'fish';
  synthesize(text: string, lang: string, opts?: CascadeTtsOptions): Promise<CascadeTtsResult | null>;
}

export const pollyBackend: CascadeTtsBackend = {
  name: 'polly',
  synthesize: async (text, lang, opts) => {
    // VTID-04336 — backend-local: the specialist speaks in Polly's
    // specialist voice for the language when one exists. When it does not,
    // or the specialist synthesis fails (the table is docs-derived, see
    // polly.ts), the receptionist request below runs exactly as before — a
    // voice-table gap costs the timbre change, never the audio.
    if (opts?.voiceRole === 'specialist' && resolvePollySpecialistVoice(lang)) {
      const specialist = await synthesizePolly({ text, lang, format: 'pcm', voiceRole: 'specialist' });
      if (specialist?.audioB64) return { audioB64: specialist.audioB64 };
      console.warn(`[VTID-04336] specialist Polly voice failed for lang='${lang}' — using the receptionist voice`);
    }
    const result = await synthesizePolly({ text, lang, format: 'pcm' });
    return result?.audioB64 ? { audioB64: result.audioB64 } : null;
  },
};

export const fishBackend: CascadeTtsBackend = {
  name: 'fish',
  // VTID-04336 — `opts` is accepted and deliberately ignored: Fish has
  // exactly one curated voice per language (`FISH_VOICES`, `sr` = Milica),
  // and a second one may only come from a manual review of a Fish-official
  // voice — never an unvetted community clone (VTID-03970 rejected one with
  // adult-content tags). The specialist keeps the curated voice; the prompt
  // still switches.
  synthesize: async (text, lang, _opts) => {
    const result = await synthesizeFish({ text, lang, format: 'pcm' });
    return result?.audioB64 ? { audioB64: result.audioB64 } : null;
  },
};

/**
 * VTID-04336 — what a cascade session in `lang` will sound like for `role`,
 * for telemetry on an in-process persona swap. Mirrors the selection order
 * of `synthesizeCascadeReply()` (Polly first, Fish only where Polly has no
 * voice). `distinct` is false when the specialist has to reuse the
 * receptionist's timbre (zh, tr, sr).
 */
export function describeCascadeVoice(
  lang: string,
  role: PollyVoiceRole,
): { backend: CascadeTtsBackend['name'] | null; voice: string | null; distinct: boolean } {
  const receptionist = resolvePollyVoice(lang);
  if (receptionist) {
    const specialist = role === 'specialist' ? resolvePollySpecialistVoice(lang) : null;
    return {
      backend: 'polly',
      voice: String((specialist ?? receptionist).voiceId),
      distinct: !!specialist,
    };
  }
  const fish = resolveFishVoice(lang);
  return { backend: fish ? 'fish' : null, voice: fish ? fish.label : null, distinct: false };
}

/**
 * Synthesize a cascade turn's reply, trying Polly first and falling back to
 * Fish ONLY when Polly has no voice for the language at all — byte-for-byte
 * the same selection `CascadedLiveClient.runTurn()` ran inline before this
 * extraction (VTID-03970's original `!speech?.audioB64 &&
 * !resolvePollyVoice(lang)` gate). Returns null when neither backend can
 * serve the language — a runtime synthesis failure, since
 * `evaluateCascadeEligibility()` already proved some backend has a voice
 * for it before the session was ever opened.
 */
export async function synthesizeCascadeReply(
  text: string,
  lang: string,
  opts?: CascadeTtsOptions,
): Promise<(CascadeTtsResult & { backend: CascadeTtsBackend['name'] }) | null> {
  // VTID-04336: `opts` only tells each backend WHO is speaking; the selection
  // order below (Polly first, Fish only on a Polly coverage gap) is unchanged.
  const pollyResult = await pollyBackend.synthesize(text, lang, opts);
  if (pollyResult) return { ...pollyResult, backend: 'polly' };

  if (!resolvePollyVoice(lang)) {
    const fishResult = await fishBackend.synthesize(text, lang, opts);
    if (fishResult) return { ...fishResult, backend: 'fish' };
  }

  return null;
}
