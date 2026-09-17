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

import { synthesizePolly, resolvePollyVoice } from '../../../../services/tts/polly';
import { synthesizeFish } from '../../../../services/tts/fish';

export interface CascadeTtsResult {
  audioB64: string;
}

export interface CascadeTtsBackend {
  readonly name: 'polly' | 'fish';
  synthesize(text: string, lang: string): Promise<CascadeTtsResult | null>;
}

export const pollyBackend: CascadeTtsBackend = {
  name: 'polly',
  synthesize: async (text, lang) => {
    const result = await synthesizePolly({ text, lang, format: 'pcm' });
    return result?.audioB64 ? { audioB64: result.audioB64 } : null;
  },
};

export const fishBackend: CascadeTtsBackend = {
  name: 'fish',
  synthesize: async (text, lang) => {
    const result = await synthesizeFish({ text, lang, format: 'pcm' });
    return result?.audioB64 ? { audioB64: result.audioB64 } : null;
  },
};

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
): Promise<(CascadeTtsResult & { backend: CascadeTtsBackend['name'] }) | null> {
  const pollyResult = await pollyBackend.synthesize(text, lang);
  if (pollyResult) return { ...pollyResult, backend: 'polly' };

  if (!resolvePollyVoice(lang)) {
    const fishResult = await fishBackend.synthesize(text, lang);
    if (fishResult) return { ...fishResult, backend: 'fish' };
  }

  return null;
}
