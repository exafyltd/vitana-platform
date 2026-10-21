/**
 * Voice tool-router candidate — Phase 1 W2 (BOOTSTRAP-PHASE1-W2-SHADOW-RUNTIME-WIRE).
 *
 * The shadow "candidate" side of the voice-tool-router experiment. Given the
 * user's transcript, it predicts which tool the voice assistant should call —
 * the same decision the primary path (Vertex/Gemini function-calling) makes at
 * runtime. runWithShadow() runs this in the background and emits
 * eval.shadow.compared so the auto-promoter can track agreement vs the primary.
 *
 * W2 is shadow-only and NO trained fine-tune exists yet, so this stub simply
 * echoes the primary's chosen tool — agreement is trivially 1.0. Its job in W2
 * is to prove the wire end-to-end (events flow, auto-promoter sees non-zero
 * samples, stays in DRY mode). When the first voice-tool-router fine-tune lands
 * (later week), swap the body for a real call to the served candidate model;
 * the call site in orb-live.ts does not change.
 */

export interface VoiceToolRouteInput {
  /** The user utterance that drove the tool decision (current turn transcript). */
  transcript: string;
  /** The tool the primary (Vertex) path chose — the supervision signal in W2. */
  primaryTool: string;
}

/**
 * Predict the tool name from the transcript. W2 stub: echo the primary choice.
 * Returns the tool name (the comparable key extractKey() reads).
 */
export async function predictVoiceToolRoute(input: VoiceToolRouteInput): Promise<string> {
  // W2 stub — no fine-tune served yet. Echo the primary's decision so the
  // shadow pipeline produces well-formed eval.shadow.compared events.
  return input.primaryTool;
}
