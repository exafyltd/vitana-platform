/**
 * VTID-04336 — Vitana → specialist hand-off for upstream clients that swap
 * persona IN PROCESS instead of by reconnect.
 *
 * Nova Sonic and Vertex Live hold one long-lived stream whose setup carries
 * the system prompt and the voice, so a persona swap closes the upstream with
 * reason `persona_swap` and the reconnect rebuilds setup with the specialist's
 * prompt (`personaSystemOverride`) and voice (`personaVoiceOverride`).
 *
 * The cascade (Transcribe → Bedrock → Polly/Fish, `CascadedLiveClient`) has no
 * such stream: every turn is a fresh Bedrock call and a fresh TTS call. Closing
 * it would tear down the Transcribe pipe and gain nothing, so it exposes
 * `applyPersona()` and the session layer calls that instead. This module is
 * the single place that turns the session's persona state into that call, so
 * `handleTurnComplete` stays a one-line branch.
 */

import type { PollyVoiceRole } from '../../../services/tts/polly';

/** The receptionist persona key (mirrors `RECEPTIONIST_PERSONA_KEY`). */
export const RECEPTIONIST_PERSONA = 'vitana';

/** Minimal shape of an upstream client that can swap persona in process. */
export interface InProcessPersonaSwapClient {
  applyPersona(input: {
    persona: string;
    systemInstruction?: string | null;
    appendix?: string | null;
    voiceRole: PollyVoiceRole;
    openWithGreeting: boolean;
  }): {
    persona: string;
    voiceRole: PollyVoiceRole;
    instructionChars: number;
    restoredBaseInstruction: boolean;
  };
}

/** True when the client swaps persona in process (today: the cascade only). */
export function supportsInProcessPersonaSwap(client: unknown): client is InProcessPersonaSwapClient {
  return !!client && typeof (client as { applyPersona?: unknown }).applyPersona === 'function';
}

/** Persona fields the tool handlers (`switch_persona`, `report_to_specialist`) set. */
export interface PersonaSwapSessionState {
  personaSystemOverride?: string | null;
  specialistContextSection?: string | null;
  lastTranscriptSection?: string | null;
}

/**
 * Build the `applyPersona()` input for a swap to `persona`.
 *
 * - Specialist: the specialist's full prompt (`personaSystemOverride`, built
 *   by the tool handler exactly as for the Nova reconnect), the specialist
 *   voice, and an opening turn — the Nova reconnect's greeting nudge.
 * - Back to Vitana: the connect-time instruction restored, plus the context
 *   the tool handler cached for the swap-back (what the specialist filed, the
 *   hand-off transcript), the receptionist voice, and NO opening turn — the
 *   swap-back is silent by design (switch_persona's loop fix: Vitana waits for
 *   the member instead of re-greeting).
 */
export function buildInProcessPersonaSwap(
  state: PersonaSwapSessionState,
  persona: string,
): Parameters<InProcessPersonaSwapClient['applyPersona']>[0] {
  if (persona === RECEPTIONIST_PERSONA) {
    const appendix = [state.specialistContextSection, state.lastTranscriptSection]
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter((s) => s.length > 0)
      .join('\n\n');
    return {
      persona,
      systemInstruction: null,
      appendix: appendix || null,
      voiceRole: 'receptionist',
      openWithGreeting: false,
    };
  }
  return {
    persona,
    systemInstruction: state.personaSystemOverride ?? null,
    appendix: null,
    voiceRole: 'specialist',
    openWithGreeting: true,
  };
}
