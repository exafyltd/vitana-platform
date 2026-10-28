/**
 * orb.turn.responded payload assembly — BOOTSTRAP-VOICE-DATASET-EMITTER.
 *
 * The Phase 1 voice-tool-routing dataset extractor
 * (services/gateway/scripts/datasets/voice-tool-routing.ts) projects the
 * tool-routing signal off the emitted event's `metadata` column:
 *
 *   const toolName  = meta.tool_name ?? meta.tool_call?.name;
 *   const userInput = meta.transcript ?? meta.input_text;
 *   tool_arguments  = meta.tool_call?.arguments ?? null;
 *
 * The W1/W2 emitter only ever carried { reply_preview, provider, mode, ... } —
 * NONE of tool_name / tool_call / transcript / input_text — so every candidate
 * row failed the `if (!toolName || !userInput) continue;` guard and the cron
 * extracted ZERO real rows even after consent. This module closes the wire by
 * aligning the emitter's payload to the extractor's projection.
 *
 * `emitOasisEvent` maps the WHOLE event `payload` into the oasis_events
 * `metadata` column (oasis-event-service.ts: `metadata: { ...callerMetadata }`),
 * so these fields must live at the TOP LEVEL of the payload — not nested under
 * the legacy `payload.metadata: { mode }` object the extractor never reads.
 *
 * PII / consent contract (hard rule — see data-export-consent.ts + PII_FILTER.md):
 * `transcript` / `input_text` are RAW user content and the tool-routing signal
 * is derived telemetry. They are included ONLY when the turn is export-eligible:
 *   1. export consent is established for the surface — i.e. the spread consent
 *      tag carries `data_export_ok: true` (same flag the SQL PII gate filters on)
 *   AND
 *   2. the turn is NOT under a `safety.guardrail.*` exclusion.
 * When either condition fails, the tool-routing/transcript fields are omitted
 * entirely; only the non-PII envelope (reply_preview length, provider, mode)
 * is emitted. Fail-closed by construction — no broadening for non-consented
 * users.
 */

/** The tool-routing signal the extractor needs, captured for the finalized turn. */
export interface OrbTurnToolSignal {
  /** The tool/function name Vertex selected for this turn (extractor: tool_name). */
  toolName?: string | null;
  /** Raw user input transcript for the turn (extractor: transcript / input_text). */
  inputText?: string | null;
  /** Structured tool_call — extractor reads .name and .arguments as fallbacks. */
  toolCall?: { name?: string; arguments?: Record<string, unknown> } | null;
}

export interface BuildOrbTurnPayloadInput {
  orbSessionId: string;
  conversationId: string;
  replyText: string;
  provider: string;
  /** Spread result of `dataExportConsentTag(...)` — `{ data_export_ok: true }` or `{}`. */
  consentTag: { data_export_ok?: true } | Record<string, never>;
  /** Tool-routing signal for the turn (optional — many turns dispatch no tool). */
  toolSignal?: OrbTurnToolSignal;
  /**
   * True when the turn was caught by a `safety.guardrail.*` exclusion. When set,
   * the raw transcript / tool-routing fields are withheld even if consent holds.
   */
  guardrailExcluded?: boolean;
}

/**
 * Build the `orb.turn.responded` event payload.
 *
 * Always-present envelope (non-PII, no regression to existing consumers):
 *   orb_session_id, conversation_id, reply_length, reply_preview, provider,
 *   metadata:{ mode }, and the spread consent tag.
 *
 * Export-eligible-only (consent established AND not guardrail-excluded), aligned
 * to the extractor's field names so real signal flows:
 *   tool_name, tool_call, transcript, input_text.
 */
export function buildOrbTurnRespondedPayload(
  input: BuildOrbTurnPayloadInput,
): Record<string, unknown> {
  const {
    orbSessionId,
    conversationId,
    replyText,
    provider,
    consentTag,
    toolSignal,
    guardrailExcluded,
  } = input;

  // Existing fields preserved verbatim — other consumers depend on these.
  const payload: Record<string, unknown> = {
    orb_session_id: orbSessionId,
    conversation_id: conversationId,
    reply_length: replyText.length,
    reply_preview: replyText.slice(0, 140),
    provider,
    metadata: { mode: 'orb_voice' },
    ...consentTag,
  };

  // PII gate: only attach raw transcript + tool-routing signal when the turn is
  // export-eligible. data_export_ok must be strictly true AND no guardrail.
  const exportEligible = consentTag.data_export_ok === true && !guardrailExcluded;
  if (!exportEligible || !toolSignal) return payload;

  const toolName = toolSignal.toolName ?? toolSignal.toolCall?.name ?? undefined;
  const inputText =
    typeof toolSignal.inputText === 'string' && toolSignal.inputText.length > 0
      ? toolSignal.inputText
      : undefined;

  // tool_name: top-level key the extractor reads first.
  if (toolName) {
    payload.tool_name = toolName;
    payload.tool_dispatched = true;
  }

  // tool_call: structured fallback the extractor reads (.name / .arguments).
  if (toolSignal.toolCall && (toolSignal.toolCall.name || toolSignal.toolCall.arguments)) {
    payload.tool_call = {
      ...(toolSignal.toolCall.name ? { name: toolSignal.toolCall.name } : {}),
      ...(toolSignal.toolCall.arguments ? { arguments: toolSignal.toolCall.arguments } : {}),
    };
  } else if (toolName) {
    // Always give the extractor a tool_call.name fallback when a tool was chosen.
    payload.tool_call = { name: toolName };
  }

  // transcript + input_text: raw user content, only here under consent.
  if (inputText) {
    payload.transcript = inputText;
    payload.input_text = inputText;
  }

  return payload;
}
