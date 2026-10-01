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
import { synthesizeFish, resolveFishVoice, isFishConfigured } from '../../../../services/tts/fish';

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
    if (opts?.voiceRole === 'specialist') {
      // VTID-04445 — Devon speaks ONLY with a male voice. When Polly has one
      // for the language, it gets one retry on a transient failure; there is
      // no fall-back to Vitana's female voice any more (VTID-04336 had one).
      // No male Polly voice (tr, zh, sr) → null, and the caller tries Fish.
      if (!resolvePollySpecialistVoice(lang)) return null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const specialist = await synthesizePolly({ text, lang, format: 'pcm', voiceRole: 'specialist' });
        if (specialist?.audioB64) return { audioB64: specialist.audioB64 };
        console.warn(`[VTID-04445] specialist Polly voice failed for lang='${lang}' (attempt ${attempt}/2) — never falling back to the female voice`);
      }
      return null;
    }
    const result = await synthesizePolly({ text, lang, format: 'pcm' });
    return result?.audioB64 ? { audioB64: result.audioB64 } : null;
  },
};

export const fishBackend: CascadeTtsBackend = {
  name: 'fish',
  // VTID-04445 — the role picks the voice: Milica for Vitana (sr), and the
  // male Fish Official voices for Devon (sr Nikola, tr Kerem, zh Zixuan).
  // Only voices from Fish's official account are ever curated (VTID-03970).
  synthesize: async (text, lang, opts) => {
    const result = await synthesizeFish({
      text,
      lang,
      format: 'pcm',
      voiceRole: opts?.voiceRole === 'specialist' ? 'specialist' : 'receptionist',
    });
    return result?.audioB64 ? { audioB64: result.audioB64 } : null;
  },
};

/**
 * VTID-04445 — the voice Devon (the specialist) would speak with on the
 * cascade in `lang`: Polly's male voice, else the male Fish voice when Fish
 * is configured, else none. `null` means a hand-off to Devon cannot happen
 * in this language on the cascade — Devon never speaks with Vitana's voice.
 */
export function resolveCascadeSpecialistVoice(
  lang: string,
): { backend: CascadeTtsBackend['name']; voice: string } | null {
  const polly = resolvePollySpecialistVoice(lang);
  if (polly) return { backend: 'polly', voice: String(polly.voiceId) };
  const fish = isFishConfigured() ? resolveFishVoice(lang, 'specialist') : null;
  if (fish) return { backend: 'fish', voice: fish.label };
  return null;
}

/**
 * VTID-04336 — what a cascade session in `lang` will sound like for `role`,
 * for telemetry on an in-process persona swap. `distinct` is true when the
 * specialist has a voice of their own (VTID-04445: always the case when a
 * hand-off was allowed — see `resolveCascadeSpecialistVoice`).
 */
export function describeCascadeVoice(
  lang: string,
  role: PollyVoiceRole,
): { backend: CascadeTtsBackend['name'] | null; voice: string | null; distinct: boolean } {
  if (role === 'specialist') {
    const specialist = resolveCascadeSpecialistVoice(lang);
    return { backend: specialist?.backend ?? null, voice: specialist?.voice ?? null, distinct: !!specialist };
  }
  const receptionist = resolvePollyVoice(lang);
  if (receptionist) return { backend: 'polly', voice: String(receptionist.voiceId), distinct: false };
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

  // VTID-04445 — Devon: Fish is his only voice where Polly has no male one
  // (tr, zh, sr). Where Polly does have one and it failed, there is no Fish
  // male voice to try and no female fallback: the turn fails loudly.
  if (opts?.voiceRole === 'specialist') {
    if (resolvePollySpecialistVoice(lang)) return null;
    const fishSpecialist = await fishBackend.synthesize(text, lang, opts);
    return fishSpecialist ? { ...fishSpecialist, backend: 'fish' } : null;
  }

  if (!resolvePollyVoice(lang)) {
    const fishResult = await fishBackend.synthesize(text, lang, opts);
    if (fishResult) return { ...fishResult, backend: 'fish' };
  }

  return null;
}
