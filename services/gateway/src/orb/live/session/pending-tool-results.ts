/**
 * BOOTSTRAP-ORB-TOOL-CARRYOVER: keep a tool result alive across a reconnect.
 *
 * THE BUG THIS EXISTS FOR (production trace, session live-3577c2fa, 2026-07-30):
 *
 *   15:05:40.200  tool_call        narrate_guided_session
 *   15:05:40.507  tool.executed    success in 306ms, 726 chars returned
 *   15:05:40 → 15:06:00            audio_out frozen — the model emits NOTHING
 *   15:06:00.181  watchdog_fired   reason=text_stall (20s)
 *   15:06:00.184  upstream_ws_close code=1006
 *   15:06:00.186  reconnect_triggered reason=stall_recovery
 *   15:06:33      user: "You said that you can guide me through my next step…"
 *
 * The tool SUCCEEDED. What the user then experienced was Vitana coming back
 * with no idea she had been asked to narrate anything — "she answers as if
 * it's the first time, without any follow-up".
 *
 * Two independent reasons the tool result does not survive the reconnect, and
 * BOTH have to be handled or the carry-over silently does nothing:
 *
 *   1. The rebuilt system instruction re-injects the last N *transcript* turns.
 *      A function response is not a transcript turn — it is never in there.
 *
 *   2. On Vertex the reconnect prefers NATIVE session resumption via
 *      `session.resumptionHandle`. That handle is a CHECKPOINT, issued
 *      periodically — in the trace above at 15:05:32, i.e. EIGHT SECONDS
 *      BEFORE the tool call. Resuming from it rewinds the server-side
 *      conversation to a point where the tool call had not happened yet, so
 *      the model has no memory of it and nothing re-triggers it.
 *
 * Reason 2 is why this block must be injected EVEN WHEN a resumption handle
 * exists — the opposite of `reconnectHistory`, which is deliberately skipped
 * in that case to avoid duplicating context the handle already carries. A
 * handle cannot carry something that happened after the checkpoint it names.
 *
 * Provider-agnostic on purpose: both the Vertex and Nova paths build their
 * instruction from the same envelope builder, so this lands on whichever
 * provider a session actually resolved to.
 */

/** A tool result the model has NOT yet acted on. */
export interface PendingToolResult {
  toolName: string;
  /** The model-facing output text (what was put in the function response). */
  output: string;
  recordedAt: number;
}

/**
 * Only the most recent few matter — a stalled turn is one or two tool calls
 * deep, not twenty, and the block is injected into a byte-budgeted prompt.
 */
export const MAX_PENDING_TOOL_RESULTS = 3;

/**
 * Per-result cap. Guided-journey narrations run to ~2.6k chars today; 4000
 * keeps a full one intact while bounding a pathological payload. Matches the
 * Nova instruction chunk size so a carried result can never be the thing that
 * pushes a single event over Nova's validation limit.
 */
export const MAX_PENDING_OUTPUT_CHARS = 4000;

interface PendingCarrier {
  _pendingToolResults?: PendingToolResult[];
}

/**
 * Record a tool result as "sent upstream but not yet acted on".
 *
 * Call this ONLY where the function response actually went out — a result we
 * failed to send is not pending, it never happened, and replaying it after a
 * reconnect would make the model narrate something the user never triggered.
 */
export function recordPendingToolResult(
  session: unknown,
  toolName: string,
  output: string | undefined | null,
): void {
  if (!session || typeof session !== 'object') return;
  if (!toolName) return;
  // An empty result carries nothing to resume from — recording it would inject
  // a bare "Tool X returned:" line into the rebuilt prompt, which is noise the
  // model has to interpret. Nothing to continue means nothing to carry.
  const text = (output ?? '').trim();
  if (!text) return;
  const carrier = session as PendingCarrier;
  const list = carrier._pendingToolResults ?? [];
  list.push({
    toolName,
    output: text.slice(0, MAX_PENDING_OUTPUT_CHARS),
    recordedAt: Date.now(),
  });
  while (list.length > MAX_PENDING_TOOL_RESULTS) list.shift();
  carrier._pendingToolResults = list;
}

/**
 * The model produced a complete turn, so it consumed whatever was pending.
 * Returns how many were cleared (for telemetry).
 */
export function clearPendingToolResults(session: unknown): number {
  if (!session || typeof session !== 'object') return 0;
  const carrier = session as PendingCarrier;
  const n = carrier._pendingToolResults?.length ?? 0;
  carrier._pendingToolResults = [];
  return n;
}

export function getPendingToolResults(session: unknown): PendingToolResult[] {
  if (!session || typeof session !== 'object') return [];
  return (session as PendingCarrier)._pendingToolResults ?? [];
}

/**
 * Render the resume block appended to the rebuilt system instruction.
 *
 * Deliberately phrased as "you already called this and here is what came
 * back — continue now", NOT "call it again": re-calling `narrate_guided_session`
 * would advance the journey cursor a second time (it marks the topic complete
 * on each call), silently skipping a session the user never heard.
 *
 * Returns '' when nothing is pending so callers can concatenate unconditionally.
 */
export function buildPendingToolResumeBlock(pending: PendingToolResult[]): string {
  if (!pending || pending.length === 0) return '';
  const items = pending
    .map(
      (p) =>
        `- Tool \`${p.toolName}\` returned:\n${p.output}`,
    )
    .join('\n\n');
  return (
    `\n\n--- UNFINISHED WORK FROM BEFORE THE RECONNECT ---\n` +
    `The connection dropped while you were acting on a tool result. You ALREADY ` +
    `called the tool(s) below and this is what they returned — do NOT call them ` +
    `again (that would double-advance the user's progress). Continue from here as ` +
    `if nothing had interrupted you: deliver what this result asks for, in the ` +
    `session's language, without re-greeting the user and without asking them to ` +
    `repeat themselves.\n\n${items}`
  );
}
