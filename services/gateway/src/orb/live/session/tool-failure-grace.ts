/**
 * VTID-03245 — voice tool-failure grace layer (offer-integrity).
 *
 * The ORB must never "guide the user to something it cannot perform" and then
 * surface the failure as a spoken "we have issues with the system." When a
 * voice tool returns a hard failure (`success === false`), the model must not
 * receive the raw error — it should receive a function-response that tells it
 * to briefly acknowledge and PIVOT to something it can actually do, without
 * ever mentioning an error/bug/"issues."
 *
 * This is the "no degraded/partial flag in voice-tool responses" rule made
 * structural: the model-facing function_response shape always reads as a
 * non-failure, carrying spoken guidance instead of an error string.
 *
 * Parity: the underlying tools are shared by Vertex and LiveKit
 * (orb-tools-shared). This helper reshapes the MODEL-FACING result; it is
 * applied at each transport's send-to-model boundary (Vertex:
 * upstream-message-handler before sendFunctionResponseToLiveAPI; LiveKit: the
 * orb-agent when it forwards the /orb/tool result to its model — see
 * docs/patches/orb-agent).
 */

export interface RawToolResult {
  success: boolean;
  result?: string;
  error?: string;
  [k: string]: unknown;
}

/** A hard tool failure (execution error), not an empty-but-ok result. */
export function isHardToolFailure(r: RawToolResult | null | undefined): boolean {
  return !!r && r.success === false;
}

/**
 * Reshape a failed tool result into a model-facing function-response that
 * hides the error and instructs an honest pivot. Pure — no IO, no mutation
 * of the input (returns a new object).
 *
 * On a successful result this is a no-op (returns the input unchanged), so
 * call sites can use it unconditionally.
 */
export function graceToolResultForModel<T extends RawToolResult>(
  toolName: string,
  raw: T,
): RawToolResult {
  if (!isHardToolFailure(raw)) return raw;
  return {
    // The model must see a non-failure shape — never an `error` field.
    success: true,
    result: JSON.stringify({
      ok: false,
      available: false,
      tool: toolName,
      speak_guidance:
        'This could not be completed right now. In ONE short, warm sentence, ' +
        'briefly acknowledge it and offer a DIFFERENT concrete thing you can ' +
        'actually do for the user (only use capabilities you have a tool for). ' +
        'Do NOT mention any error, bug, system problem, "issues", "technical", ' +
        'or that something failed — just pivot naturally and keep helping.',
    }),
  };
}
